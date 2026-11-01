import 'reflect-metadata';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {drizzle} from 'drizzle-orm/d1';
import {SignJWT,decodeJwt} from 'jose';
import {treaty} from '@elysiajs/eden';
import {it,expect,vi} from 'vitest';
import {app} from '../server';
import * as schema from '../db/schema';
import {runRequestContext} from '../utils/di';
import {ServerConfig} from '../utils/cache';
import {validateBackup,encryptBackup,decryptBackup} from '../../../client/src/features/life/backup-format';
import {reportAIRequestKey,reportDigest} from '../utils/report-analysis-format';
import {reportWindow,reportSnapshot} from '../utils/life-report';
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
  let staleReceiptRead=false;
  const prepare=(sql:string)=>{
    let values:unknown[]=[];
    const execute=()=>sqlite.prepare(sql).all(...values);
    return {bind(...args:unknown[]){values=args;return this;},async all(){return {results:execute(),meta:{}};},async raw(){return execute().map((row:Record<string,unknown>)=>Object.values(row));},async first(){if(staleReceiptRead && sql==='SELECT value FROM info WHERE key=?'){staleReceiptRead=false;return null;}return sqlite.prepare(sql).get(...values)||null;},async run(){const result=sqlite.prepare(sql).run(...values);return {results:[],meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};}};
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

  // Older clients keep the v2 manifest; v3 explicitly includes private report tables.
  sqlite.exec("INSERT INTO users(id,username,openid,permission) VALUES(21,'other-owner','other-owner',1); INSERT INTO life_report_preferences(owner_id) VALUES(1),(21); INSERT INTO life_report_ai_budget(month,reserved_fen) VALUES('2026-11',5)");
  const period=reportWindow('daily',new Date('2026-11-02T00:00:00Z'));
  for(const ownerId of [1,21]){
    const snapshot=reportSnapshot(ownerId,{version:1,ownerId,generatedAt:'2026-11-02T00:00:00Z',period,coverage:'server-synced-only',mode:'statistics-preview',achievementsRecorded:1,tasksCompleted:1,ideasCreated:0,habitCompletions:0,daysWithNotes:0,focus:{completedSessions:0,recordedMinutes:0,earlySessions:0},aiEnabled:false,emailEnabled:false});
    const json=JSON.stringify(snapshot),hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json));
    const digest=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
    sqlite.prepare('INSERT INTO life_reports(owner_id,kind,period_start,period_end,snapshot_json,snapshot_sha256) VALUES(?,?,?,?,?,?)').run(ownerId,'daily',Date.parse(period.start)/1000,Date.parse(period.end)/1000,json,digest);
  }
  const legacyAgain=await api.life.backup.get({headers});
  expect(legacyAgain.data).toMatchObject({version:2});
  expect((legacyAgain.data as any).data).not.toHaveProperty('lifeReportPreferences');
  batch.mockClear();
  const v3Response=await fetcher('http://localhost/life/backup?version=3',{headers});
  expect(v3Response.status).toBe(200);const v3=await validateBackup(await v3Response.json(),1);
  expect(v3.version).toBe(3);expect(v3.counts).toMatchObject({lifeReports:1,lifeReportPreferences:1});
  expect(v3.data.lifeReports).toEqual([expect.objectContaining({ownerId:1})]);
  expect(v3.data.lifeReportPreferences).toEqual([expect.objectContaining({ownerId:1,emailEnabled:0,aiEnabled:0})]);
  expect(Object.keys(v3.data)).not.toContain('lifeReportAIBudget');
  expect(batch).toHaveBeenCalledOnce();expect(batch.mock.calls[0][0]).toHaveLength(17);
  const v3Encrypted=await encryptBackup(v3,'synthetic-v3-application-passphrase');
  expect((await decryptBackup(v3Encrypted,'synthetic-v3-application-passphrase',1)).counts.lifeReportPreferences).toBe(1);

  // Explicit v4 adds analysis results, preserving v2/v3 manifests and one snapshot transaction.
  const ownReport=sqlite.prepare('SELECT id,snapshot_sha256 FROM life_reports WHERE owner_id=1').get();
  const text=JSON.stringify({summary:'合成统计分析。',observations:[],actions:[]});
  sqlite.prepare("INSERT INTO life_report_analyses(request_key,owner_id,report_id,snapshot_sha256,model,state,analysis_json,analysis_sha256) VALUES(?,?,?,?,?,'succeeded',?,?)").run(await reportAIRequestKey({id:ownReport.id,ownerId:1,sha256:ownReport.snapshot_sha256}),1,ownReport.id,ownReport.snapshot_sha256,'deepseek-flash',text,await reportDigest(text));
  const otherReport=sqlite.prepare('SELECT id,snapshot_sha256 FROM life_reports WHERE owner_id=21').get();
  sqlite.prepare("INSERT INTO life_report_analyses(request_key,owner_id,report_id,snapshot_sha256,model,state) VALUES(?,?,?,?,?,'pending')").run(await reportAIRequestKey({id:otherReport.id,ownerId:21,sha256:otherReport.snapshot_sha256}),21,otherReport.id,otherReport.snapshot_sha256,'deepseek-flash');
  batch.mockClear();
  const v4Response=await fetcher('http://localhost/life/backup?version=4',{headers});
  expect(v4Response.status).toBe(200);const v4=await validateBackup(await v4Response.json(),1);
  expect(v4.version).toBe(4);expect(v4.counts.lifeReportAnalyses).toBe(1);
  expect(v4.data.lifeReportAnalyses[0]).toMatchObject({ownerId:1,state:'succeeded'});
  expect(Object.keys(v4.data)).not.toContain('lifeReportAIReservations');
  expect(batch).toHaveBeenCalledOnce();expect(batch.mock.calls[0][0]).toHaveLength(18);
  const v4Encrypted=await encryptBackup(v4,'synthetic-v4-application-passphrase');
  expect((await decryptBackup(v4Encrypted,'synthetic-v4-application-passphrase',1)).counts.lifeReportAnalyses).toBe(1);
  for(const mutate of [(b:any)=>{b.data.lifeReportAnalyses[0].ownerId=21;},(b:any)=>{b.data.lifeReportAnalyses[0].analysisJson='{}';},(b:any)=>{b.data.lifeReportAnalyses[0].reportId=otherReport.id;}]){
    const invalid=structuredClone(v4);mutate(invalid);
    invalid.sha256=await reportDigest(JSON.stringify(invalid.data));
    await expect(validateBackup(invalid,1)).rejects.toThrow();
  }

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
  const config=runRequestContext(env,db,()=>ServerConfig());
  const failedNotification=vi.spyOn(config,'get').mockRejectedValueOnce(new Error('fixture notification configuration failure'));
  const comment=await fetcher('http://localhost/feed/comment/'+inserted[0],{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({content:'saved even if notification fails'})});
  expect(comment.status).toBe(200);
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM comments WHERE content=?').get('saved even if notification fails')).toMatchObject({n:1});
  failedNotification.mockRestore();

  env.GUEST_ACCESS_CODE='fixture-guest-code-not-a-real-credential';
  const guestLogin=()=>fetcher('http://localhost/user/guest',{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':'fixture-guest-ip'},body:JSON.stringify({code:env.GUEST_ACCESS_CODE})});
  const guests=await Promise.all([guestLogin(),guestLogin()]);
  expect(guests.map(response=>response.status)).toEqual([200,200]);
  const guestTokens=await Promise.all(guests.map(async response=>(await response.json() as {token:string}).token));
  expect(decodeJwt(guestTokens[0]).id).toBe(decodeJwt(guestTokens[1]).id);
  expect(sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE openid='guest:beiruoxi'").get()).toMatchObject({n:1});
  const guestHeaders={authorization:'Bearer '+guestTokens[0]};
  expect((await fetcher('http://localhost/config/server',{headers:guestHeaders})).status).toBe(401);
  expect(await (await fetcher('http://localhost/life/todos',{headers:guestHeaders})).json()).toEqual([]);
  for(const [title,content] of [['fixture diary','independent guest diary'],['independent guest memo','fixture content memo']]) {
    const ownCopy=await api.feed.post({title,content,summary:'',draft:false,kind:'diary',tags:[]},{headers:guestHeaders});
    expect(ownCopy.status,JSON.stringify(ownCopy.error)).toBe(200);
  }
  // Same-account duplicate behavior stays intact; another account's private
  // existence must not be observable through creation or direct reads.
  const duplicate=await api.feed.post({title:'fixture diary',content:'another content',summary:'',draft:false,kind:'diary',tags:[]},{headers:guestHeaders});
  expect(duplicate.status).toBe(400);
  expect((await api.feed({id:inserted[1]}).get({headers:guestHeaders})).status).toBe(403);
  // Fail the relation write after content UPDATE and old-tag DELETE. All three
  // must roll back together, including visibility/kind and timestamps.
  const originalPost=sqlite.prepare('SELECT * FROM feeds WHERE id=?').get(inserted[0]);
  const originalBindings=sqlite.prepare('SELECT * FROM feed_hashtags WHERE feed_id=?').all(inserted[0]);
  sqlite.exec(`CREATE TEMP TRIGGER fail_post_binding BEFORE INSERT ON feed_hashtags WHEN NEW.feed_id=${inserted[0]} BEGIN SELECT RAISE(ABORT,'fixture relation write failed'); END;`);
  const atomicPayload={title:'atomic update fixture',content:'atomic updated content',kind:'diary' as const,tags:['atomic replacement tag']};
  const failedSave=await api.feed({id:inserted[0]}).post(atomicPayload,{headers});
  expect(failedSave.status).toBe(500);
  expect(sqlite.prepare('SELECT * FROM feeds WHERE id=?').get(inserted[0])).toEqual(originalPost);
  expect(sqlite.prepare('SELECT * FROM feed_hashtags WHERE feed_id=?').all(inserted[0])).toEqual(originalBindings);
  sqlite.exec('DROP TRIGGER fail_post_binding');
  expect((await api.feed({id:inserted[0]}).post(atomicPayload,{headers})).status).toBe(200);
  expect(sqlite.prepare('SELECT content,kind,listed FROM feeds WHERE id=?').get(inserted[0])).toMatchObject({content:atomicPayload.content,kind:'diary',listed:0});
  const linkedTags=()=>sqlite.prepare('SELECT h.name FROM hashtags h JOIN feed_hashtags f ON f.hashtag_id=h.id WHERE f.feed_id=?').all(inserted[0]);
  expect(linkedTags()).toEqual([{name:'atomic replacement tag'}]);
  expect((await api.feed({id:inserted[0]}).post({content:'content-only retry'},{headers})).status).toBe(200);
  expect(linkedTags()).toEqual([{name:'atomic replacement tag'}]);
  expect((await api.feed({id:inserted[0]}).post({content:'clear tags together',tags:[]},{headers})).status).toBe(200);
  expect(linkedTags()).toEqual([]);
  const beforeCreate=sqlite.prepare('SELECT count(*) AS n FROM feeds').get();
  const beforeRelations=sqlite.prepare('SELECT count(*) AS n FROM feed_hashtags').get();
  sqlite.exec("CREATE TEMP TRIGGER fail_new_post_binding BEFORE INSERT ON feed_hashtags WHEN NEW.hashtag_id IN (SELECT id FROM hashtags WHERE name='blocked create tag') BEGIN SELECT RAISE(ABORT,'fixture create binding failed'); END;");
  const createPayload={title:'atomic creation fixture',content:'new post with three tags',summary:'',draft:false,kind:'memo' as const,tags:['first create tag','blocked create tag','last create tag'],createdAt:new Date('2026-10-31T00:00:00Z')};
  expect((await api.feed.post(createPayload,{headers})).status).toBe(500);
  expect(sqlite.prepare('SELECT count(*) AS n FROM feeds').get()).toEqual(beforeCreate);
  expect(sqlite.prepare('SELECT count(*) AS n FROM feed_hashtags').get()).toEqual(beforeRelations);
  sqlite.exec('DROP TRIGGER fail_new_post_binding');
  // Keep unrelated relation rowids far from post IDs: every inserted tag must
  // use the new post ID, never a preceding relation INSERT's last_insert_rowid.
  sqlite.exec('UPDATE feed_hashtags SET rowid=10000 WHERE rowid=(SELECT min(rowid) FROM feed_hashtags)');
  const retriedCreate=await api.feed.post(createPayload,{headers});
  expect(retriedCreate.status,JSON.stringify(retriedCreate.error)).toBe(200);
  if(!retriedCreate.data||typeof retriedCreate.data==='string')throw Error('Missing atomic create ID');
  const createdId=retriedCreate.data.insertedId;
  expect(sqlite.prepare('SELECT content,kind,listed,created_at FROM feeds WHERE id=?').get(createdId)).toMatchObject({content:createPayload.content,kind:'memo',listed:0,created_at:Math.floor(createPayload.createdAt.getTime()/1000)});
  expect(sqlite.prepare('SELECT h.name FROM feed_hashtags f JOIN hashtags h ON h.id=f.hashtag_id WHERE f.feed_id=? ORDER BY h.name').all(createdId)).toEqual([...createPayload.tags].sort().map(name=>({name})));
  const stablePayload={...createPayload,title:'stable create receipt',content:'stable create receipt body',clientKey:'fixture-stable-create-0001'};
  const firstCreate=await api.feed.post(stablePayload,{headers});
  expect(firstCreate.status).toBe(200);
  const replay=await api.feed.post({...stablePayload,tags:[...stablePayload.tags].reverse()},{headers});
  expect(replay.status).toBe(200);expect(replay.data).toEqual(firstCreate.data);
  // Model another request committing between the initial receipt lookup and
  // the title/content duplicate query. A second lookup must still acknowledge it.
  staleReceiptRead=true;
  const racingReplay=await api.feed.post(stablePayload,{headers});
  expect(racingReplay.status).toBe(200);expect(racingReplay.data).toEqual(firstCreate.data);
  expect(sqlite.prepare('SELECT count(*) AS n FROM feeds WHERE title=? AND uid=1').get(stablePayload.title)).toMatchObject({n:1});
  expect((await api.feed.post({...stablePayload,content:'different content'},{headers})).status).toBe(409);
  const foreignCreate=await api.feed.post(stablePayload,{headers:guestHeaders});
  expect(foreignCreate.status).toBe(200);expect(foreignCreate.data).not.toEqual(firstCreate.data);
  if(!firstCreate.data||typeof firstCreate.data==='string')throw Error('Missing receipt post ID');
  expect((await api.feed({id:firstCreate.data.insertedId}).delete(null,{headers:guestHeaders})).status).toBe(403);
  expect((await api.feed({id:firstCreate.data.insertedId}).delete(null,{headers})).status).toBe(200);
  expect((await api.feed.post(stablePayload,{headers})).status).toBe(409);
  sqlite.close();
});
