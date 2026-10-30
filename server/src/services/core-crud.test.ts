import 'reflect-metadata';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {drizzle} from 'drizzle-orm/d1';
import {SignJWT} from 'jose';
import {treaty} from '@elysiajs/eden';
import {it,expect,vi} from 'vitest';
import {app} from '../server';
import * as schema from '../db/schema';
import {runRequestContext} from '../utils/di';
import {validateBackup} from '../../../client/src/features/life/backup-format';
vi.mock('../utils/s3',()=>({createS3Client:()=>({send:vi.fn(async()=>({}))})}));
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');

it('keeps actual SQLite CRUD, scoped tags, public visibility, upload and backup contracts usable',async()=>{
  const sqlite=new DatabaseSync(':memory:');
  const folder=new URL('../../sql/',import.meta.url);
  for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file,folder),'utf8'));
    if(file==='0002.sql')sqlite.exec('ALTER TABLE feeds ADD COLUMN top INTEGER DEFAULT 0');
  }
  sqlite.exec("INSERT INTO users(id,username,openid,permission) VALUES(1,'test-owner','test-owner',1)");
  const prepare=(sql:string)=>{
    let values:unknown[]=[];
    const execute=()=>sqlite.prepare(sql).all(...values);
    return {bind(...args:unknown[]){values=args;return this;},async all(){return {results:execute(),meta:{}};},async raw(){return execute().map((row:Record<string,unknown>)=>Object.values(row));},async first(){return sqlite.prepare(sql).get(...values)||null;},async run(){const result=sqlite.prepare(sql).run(...values);return {results:[],meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};}};
  };
  const raw={prepare,async batch(statements:Array<{all:()=>Promise<unknown>}>){return Promise.all(statements.map(statement=>statement.all()));}} as any;
  const db=drizzle(raw,{schema});
  const env={DB:raw,JWT_SECRET:'test-only-signing-secret-at-least-32-characters',RIN_GITHUB_CLIENT_ID:'test-client',RIN_GITHUB_CLIENT_SECRET:'test-secret',FRONTEND_URL:'https://site.invalid',S3_ACCESS_HOST:'https://assets.invalid',S3_CACHE_FOLDER:'cache/',S3_ENDPOINT:'https://r2.invalid',S3_BUCKET:'test',S3_ACCESS_KEY_ID:'test-only',S3_SECRET_ACCESS_KEY:'test-only',S3_REGION:'auto'} as any;
  const service=runRequestContext(env,db,()=>app());
  const fetcher:typeof fetch=Object.assign((input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>runRequestContext(env,db,()=>service.handle(new Request(input,init))),{preconnect:()=>{}});
  const api=treaty<ReturnType<typeof app>>('http://localhost',{fetcher});
  const token=await new SignJWT({id:1}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));
  const headers={Authorization:'Bearer '+token};
  const inserted:number[]=[];
  for(const kind of ['article','diary','memo'] as const) {
    const created=await api.feed.post({title:'fixture '+kind,content:'fixture content '+kind,summary:'',draft:false,kind,tags:['tag '+kind],createdAt:new Date('2026-10-30T00:00:00Z')},{headers});
    expect(created.status,JSON.stringify(created.error)).toBe(200);
    if(!created.data||typeof created.data==='string')throw Error('Missing inserted feed');
    inserted.push(created.data.insertedId);
  }
  const publicPage=await api.feed.get({query:{page:1,limit:10,type:'normal'}});
  expect(publicPage.data).toMatchObject({size:1,data:[{kind:'article'}]});
  expect((await api.feed({id:inserted[1]}).get()).status).toBe(403);
  const changed=await api.feed({id:inserted[1]}).post({content:'updated private note',tags:['tag diary']},{headers});
  expect(changed.status,JSON.stringify(changed.error)).toBe(200);
  expect((await api.tag.options.get({query:{scope:'diary'},headers})).data).toEqual([{name:'tag diary'}]);
  const todo=await api.life.todos.post({content:'fixture task',type:'task',clientKey:'fixture-task-1'},{headers});
  expect(todo.status,JSON.stringify(todo.error)).toBe(200);
  expect((await api.life.todos.get({headers})).data).toEqual(expect.arrayContaining([expect.objectContaining({content:'fixture task'})]));
  const uploaded=await api.storage.post({key:'cover.png',file:new File([new Uint8Array([137,80,78,71,13,10,26,10])],'cover.png',{type:'image/png'})},{headers});
  expect(uploaded.status,JSON.stringify(uploaded.error)).toBe(200);
  expect(uploaded.data).toMatch(/^https:\/\/assets\.invalid\/.*\.png$/);
  const backup=await api.life.backup.get({headers});
  expect(backup.status,JSON.stringify(backup.error)).toBe(200);
  const validated=await validateBackup(backup.data,1);
  expect(validated.counts).toMatchObject({feeds:3,lifeTodos:1,writingTagOptions:3});
  expect(sqlite.prepare('SELECT content,listed FROM feeds WHERE id=?').get(inserted[1])).toMatchObject({content:'updated private note',listed:0});
  sqlite.close();
});
