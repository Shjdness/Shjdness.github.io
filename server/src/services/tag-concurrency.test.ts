import 'reflect-metadata';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {drizzle} from 'drizzle-orm/d1';
import {it,expect} from 'vitest';
import * as schema from '../db/schema';
import {prepareTagIds} from './tag';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');

it('creates one global tag after simultaneous absent reads without merging legacy duplicates or account options',async()=>{
  const sqlite=new DatabaseSync(':memory:');
  const folder=new URL('../../sql/',import.meta.url);
  for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file,folder),'utf8'));
    if(file==='0002.sql')sqlite.exec('ALTER TABLE feeds ADD COLUMN top INTEGER DEFAULT 0');
  }
  sqlite.exec("INSERT INTO users(id,username,openid,permission) VALUES(1,'fixture-one','one',1),(2,'fixture-two','two',2)");
  let absentReads=0,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const prepare=(query:string)=>{
    let args:unknown[]=[];
    const execute=()=>sqlite.prepare(query).all(...args);
    return {bind(...values:unknown[]){args=values;return this;},async all(){return {results:execute()};},async raw(){
      const rows=execute();
      // Hold both real SELECT snapshots at absence before either actor inserts.
      if(/\bfrom "hashtags"/i.test(query)&&!rows.length&&absentReads<2){absentReads++;if(absentReads===2)release();await gate;}
      return rows.map((row:Record<string,unknown>)=>Object.values(row));
    },async first(){return sqlite.prepare(query).get(...args);},async run(){const result=sqlite.prepare(query).run(...args);return {results:[],meta:{changes:Number(result.changes)}};}};
  };
  const db=drizzle({prepare} as any,{schema});
  try {
    const results=await Promise.all([prepareTagIds(db,1,'diary',['concurrent tag']),prepareTagIds(db,2,'memo',['concurrent tag'])]);
    expect(absentReads).toBe(2);expect(results[0]).toEqual(results[1]);
    expect(sqlite.prepare('SELECT count(*) AS n FROM hashtags WHERE name=?').get('concurrent tag')).toMatchObject({n:1});
    expect(sqlite.prepare('SELECT owner_id,scope,name FROM writing_tag_options ORDER BY owner_id').all()).toEqual([{owner_id:1,scope:'diary',name:'concurrent tag'},{owner_id:2,scope:'memo',name:'concurrent tag'}]);
    sqlite.prepare('INSERT INTO hashtags(name) VALUES(?),(?)').run('legacy duplicate','legacy duplicate');
    const oldIds=sqlite.prepare('SELECT id FROM hashtags WHERE name=?').all('legacy duplicate').map((row:{id:number})=>row.id);
    const reused=await prepareTagIds(db,1,'diary',['legacy duplicate']);
    expect(oldIds).toContain(reused[0]);
    expect(sqlite.prepare('SELECT id FROM hashtags WHERE name=?').all('legacy duplicate').map((row:{id:number})=>row.id)).toEqual(oldIds);
    const literal="quote'); DROP TABLE users;--";
    expect(await prepareTagIds(db,1,'diary',[literal])).toHaveLength(1);
    expect(sqlite.prepare('SELECT name FROM hashtags WHERE name=?').get(literal)).toMatchObject({name:literal});
    expect(sqlite.prepare('SELECT count(*) AS n FROM users').get()).toMatchObject({n:2});
  } finally {sqlite.close();}
});
