import {createRequire} from 'node:module';
import {it,expect,vi} from 'vitest';
import {createPostWithTags,findPostCreate,deletePostWithReceipts,PostCreateConflictError} from './post-create';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');

function fixture() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec("CREATE TABLE info(key TEXT UNIQUE NOT NULL,value TEXT NOT NULL);CREATE TABLE feeds(id INTEGER PRIMARY KEY,uid INTEGER,content TEXT);CREATE TABLE feed_hashtags(feed_id INTEGER,hashtag_id INTEGER);INSERT INTO info(rowid,key,value) VALUES(500,'unrelated-config','not JSON');INSERT INTO feeds VALUES(7,1,'original');INSERT INTO feed_hashtags(rowid,feed_id,hashtag_id) VALUES(900,7,1)");
  const prepare=(sql:string)=>{let args:unknown[]=[];return {bind(...values:unknown[]){args=values;return this;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async first(){return sqlite.prepare(sql).get(...args)||null;}};};
  let queue=Promise.resolve();
  const db={prepare,batch(statements:Array<{all:()=>Promise<unknown>}>) {
    const result=queue.then(async()=>{sqlite.exec('BEGIN');try{const rows=[];for(const statement of statements)rows.push(await statement.all());sqlite.exec('COMMIT');return rows;}catch(error){sqlite.exec('ROLLBACK');throw error;}});
    queue=result.then(()=>{},()=>{});return result;
  }} as any;
  const operation={ownerId:1,clientKey:'fixture-operation-0001',requestHash:'fixture hash'};
  const insert=(uid=1)=>({sql:'INSERT INTO feeds(uid,content) VALUES(?,?) RETURNING id',params:[uid,'fixture body']});
  return {sqlite,db,operation,insert};
}

it('acknowledges concurrent same-key creates once and scopes receipts by account and payload',async()=>{
  const {sqlite,db,operation,insert}=fixture();
  try {
    const saved=await Promise.all([createPostWithTags(db,insert(),[11,12],operation),createPostWithTags(db,insert(),[11,12],operation)]);
    expect(saved[0]).toEqual(saved[1]);expect(saved[0]).toEqual({insertedId:8});
    expect(sqlite.prepare('SELECT count(*) AS n FROM feeds').get()).toMatchObject({n:2});
    expect(sqlite.prepare('SELECT DISTINCT feed_id FROM feed_hashtags WHERE hashtag_id IN (11,12)').all()).toEqual([{feed_id:8}]);
    expect(await findPostCreate(db,operation)).toEqual(saved[0]);
    await expect(findPostCreate(db,{...operation,requestHash:'modified request'})).rejects.toBeInstanceOf(PostCreateConflictError);
    const other=await createPostWithTags(db,insert(2),[],{...operation,ownerId:2});
    expect(other.insertedId).not.toBe(saved[0].insertedId);
    expect(await findPostCreate(db,{...operation,ownerId:2})).toEqual(other);
  } finally {sqlite.close();}
});

it('rolls back both the receipt and post on relation failure and allows the same operation to retry',async()=>{
  const {sqlite,db,operation,insert}=fixture();
  try {
    sqlite.exec("CREATE TRIGGER fail_relation BEFORE INSERT ON feed_hashtags WHEN NEW.hashtag_id=999 BEGIN SELECT RAISE(ABORT,'fixture relation failure'); END");
    await expect(createPostWithTags(db,insert(),[11,999],operation)).rejects.toThrow();
    expect(await findPostCreate(db,operation)).toBeUndefined();
    expect(sqlite.prepare('SELECT count(*) AS n FROM feeds').get()).toMatchObject({n:1});
    expect(sqlite.prepare('SELECT count(*) AS n FROM feed_hashtags').get()).toMatchObject({n:1});
    sqlite.exec('DROP TRIGGER fail_relation');
    expect(await createPostWithTags(db,insert(),[11,999],operation)).toEqual({insertedId:8});
  } finally {sqlite.close();}
});

it('tombstones deletion atomically and rejects replay after SQLite reuses the old post ID',async()=>{
  const {sqlite,db,operation,insert}=fixture();
  try {
    const saved=await createPostWithTags(db,insert(),[],operation);
    sqlite.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON feeds BEGIN SELECT RAISE(ABORT,'fixture delete failure'); END");
    await expect(deletePostWithReceipts(db,1,saved.insertedId)).rejects.toThrow();
    expect(await findPostCreate(db,operation)).toEqual(saved);
    sqlite.exec('DROP TRIGGER fail_delete');
    await deletePostWithReceipts(db,1,saved.insertedId);
    const tombstone=JSON.parse(sqlite.prepare("SELECT value FROM info WHERE key LIKE 'post-create:%'").get().value);
    expect(tombstone).toMatchObject({deleted:true,insertedId:saved.insertedId});expect(tombstone).not.toHaveProperty('requestHash');
    expect(await createPostWithTags(db,insert(),[])).toEqual(saved);
    await expect(findPostCreate(db,operation)).rejects.toBeInstanceOf(PostCreateConflictError);
    await expect(createPostWithTags(db,insert(),[],operation)).rejects.toBeInstanceOf(PostCreateConflictError);
  } finally {sqlite.close();}
});

it('preserves wrapped quota failures without performing recovery reads',async()=>{
  const first=vi.fn(),error=new Error('driver wrapper',{cause:new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit.")});
  const db={prepare:()=>({bind(){return this;},first}),batch:async()=>{throw error;}} as any;
  await expect(createPostWithTags(db,{sql:'fixture insert',params:[]},[],{ownerId:1,clientKey:'fixture-operation-0001',requestHash:'hash'})).rejects.toBe(error);
  expect(first).not.toHaveBeenCalled();
});
