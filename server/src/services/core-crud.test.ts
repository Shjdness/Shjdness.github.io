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
import {validateBackup,encryptBackup,decryptBackup} from '../../../client/src/features/life/backup-format';
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
  let afterBatch: (()=>void)|undefined;
  const batch=vi.fn(async(statements:Array<{all:()=>Promise<unknown>}>)=>{
    sqlite.exec('BEGIN');
    let result:unknown[];
    try{result=await Promise.all(statements.map(statement=>statement.all()));sqlite.exec('COMMIT');}
    catch(error){sqlite.exec('ROLLBACK');throw error;}
    afterBatch?.();
    return result;
  });
  const raw={prepare,batch} as any;
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
  batch.mockClear();
  afterBatch=()=>{
    // A foreground edit committed immediately after the read transaction must
    // not change any table in the already captured backup.
    sqlite.prepare('UPDATE feeds SET content=? WHERE id=?').run('new edit after snapshot',inserted[1]);
    sqlite.prepare('DELETE FROM feed_hashtags WHERE feed_id=?').run(inserted[1]);
  };
  const backup=await api.life.backup.get({headers});
  afterBatch=undefined;
  expect(backup.status,JSON.stringify(backup.error)).toBe(200);
  const validated=await validateBackup(backup.data,1);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(batch.mock.calls[0][0]).toHaveLength(15);
  expect(validated.counts).toMatchObject({feeds:3,lifeTodos:1,writingTagOptions:3});
  expect(validated.data.feeds).toContainEqual(expect.objectContaining({id:inserted[1],content:'updated private note'}));
  expect(validated.data.feedHashtags).toContainEqual(expect.objectContaining({feedId:inserted[1]}));
  expect(sqlite.prepare('SELECT content,listed FROM feeds WHERE id=?').get(inserted[1])).toMatchObject({content:'new edit after snapshot',listed:0});
  const encrypted=await encryptBackup(validated,'isolated-fixture-recovery-passphrase');
  expect((await decryptBackup(JSON.parse(JSON.stringify(encrypted)),'isolated-fixture-recovery-passphrase',1)).data).toEqual(JSON.parse(JSON.stringify(validated.data)));

  for(const [url,body,table] of [
    ['/life/todos',{content:'concurrent task',type:'task',clientKey:'parallel-todo'},'life_todos'],
    ['/life/basics',{content:'concurrent basic',date:'2026-10-30',sortOrder:0,clientKey:'parallel-basic'},'daily_basics'],
    ['/habit',{name:'concurrent habit',clientKey:'parallel-habit'},'habits'],
  ] as const) {
    const create=()=>fetcher('http://localhost'+url,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
    const results=await Promise.all([create(),create()]);
    expect(results.map(result=>result.status)).toEqual([200,200]);
    const ids=await Promise.all(results.map(result=>result.json()));
    expect(ids[0]).toEqual(ids[1]);
    expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE owner_id=1 AND client_key=?`).get(body.clientKey)).toMatchObject({n:1});
  }
  // The content-based uniqueness constraint also needs a stable acknowledgement
  // when different tabs generated different local operation keys.
  const basics=await Promise.all(['different-key-a','different-key-b'].map(clientKey=>fetcher('http://localhost/life/basics',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({content:'same daily item',date:'2026-10-30',sortOrder:1,clientKey})})));
  expect(basics.map(result=>result.status)).toEqual([200,200]);
  expect(await basics[0].json()).toEqual(await basics[1].json());
  sqlite.close();
});
