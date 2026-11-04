import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {readRssDigest,rssDigestQuery,rssDigestLines,rssDigestValue} from './report-rss-digest';
import {ingestVideos,type VideoRecord} from '../services/rss/ingestion';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
const from=new Date('2026-11-03T21:00:00Z'),to=new Date('2026-11-04T21:00:00Z'),middle=new Date('2026-11-04T12:00:00Z');
function fixture(){
 const sqlite=new DatabaseSync(':memory:'),folder=new URL('../../sql/',import.meta.url);
 for(const file of readdirSync(folder).filter(s=>s.endsWith('.sql')).sort()){sqlite.exec(readFileSync(new URL(file,folder),'utf8'));if(file==='0002.sql')sqlite.exec('ALTER TABLE feeds ADD COLUMN top INTEGER DEFAULT 0');}
 sqlite.exec("INSERT INTO users(id,username,openid,permission) VALUES(1,'a','a',1),(2,'b','b',1); INSERT INTO rss_subscriptions(id,owner_id,title,alias,category,feed_url,source_url) VALUES(1,1,'音乐频道','练琴频道','音乐','https://invalid.test/1','https://invalid.test/1'),(2,1,'技术频道','','技术｜知识','https://invalid.test/2','https://invalid.test/2'),(3,2,'另一账号的私密别名','','私有分类','https://invalid.test/3','https://invalid.test/3')");
 const db={prepare(sql:string){let args:unknown[]=[];return {bind(...values:unknown[]){args=values;return this;},async all(){return {success:true,results:sqlite.prepare(sql).all(...args),meta:{rows_read:0,rows_written:0}};},async run(){const r=sqlite.prepare(sql).run(...args);return {success:true,results:[],meta:{rows_read:0,rows_written:Number(r.changes)}};}};},async batch(statements:any[]){sqlite.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.all());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}} as any;
 return {sqlite,db};
}
const video=(id:string):VideoRecord=>({externalId:id,title:'文章标题不得进入此摘要',summary:'正文不进入摘要',author:'作者',url:'',embedUrl:'',thumbnailUrl:'',publishedAt:new Date('2020-01-02T00:00:00Z')});
it('uses real first-discovery writes to separate updates/history/fallback, skips repeats and isolates owners',async()=>{
 const f=fixture();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(middle);
 try{
  await ingestVideos(f.db,{id:1,ownerId:1},[video('abcdefghijk')],'feed');
  await ingestVideos(f.db,{id:1,ownerId:1},[video('abcdefghijk'),video('lmnopqrstuv')],'history');
  await ingestVideos(f.db,{id:2,ownerId:1},[video('12345678901')],'fallback');
  await ingestVideos(f.db,{id:2,ownerId:1},[{...video('12345678901'),title:'changed'}],'push');
  await ingestVideos(f.db,{id:3,ownerId:2},[video('zyxwvutsrqp')],'feed');
  const digest=await readRssDigest(f.db,1,from,to);
  expect(digest).toMatchObject({updates:{items:2,channels:2},history:{items:1,channels:1},unclassified:{items:0,channels:0}});
  const text=rssDigestLines(digest).join('\n');expect(text).toContain('音乐｜1 条｜练琴频道（1）');expect(text).toContain('技术｜知识｜1 条｜技术频道（1）');
  expect(text).not.toContain('另一账号');expect(text).not.toContain('文章标题');expect(text).not.toContain('正文不进入');expect(JSON.stringify(digest)).not.toContain('ownerId');
  const changes=f.sqlite.prepare('SELECT total_changes() n').get().n;await readRssDigest(f.db,1,from,to);expect(f.sqlite.prepare('SELECT total_changes() n').get().n).toBe(changes);
 }finally{vi.useRealTimers();f.sqlite.close();}
});
it('keeps unknown legacy rows explicit and uses adjacent half-open second windows',async()=>{
 const f=fixture();try{
  const insert=f.sqlite.prepare('INSERT INTO rss_items(owner_id,subscription_id,external_id,title,url,published_at,created_at) VALUES(1,1,?,?,?,0,?)');
  insert.run('abcdefghijk','legacy','https://invalid.test/a',from.getTime()/1000);
  insert.run('lmnopqrstuv','at-cutoff','https://invalid.test/b',to.getTime()/1000);
  const first=await readRssDigest(f.db,1,from,to);expect(first.unclassified.items).toBe(1);expect(first.updates.items).toBe(0);
  const second=await readRssDigest(f.db,1,to,new Date(to.getTime()+86400000));expect(second.unclassified.items).toBe(1);
  const q=rssDigestQuery(1,new Date(from.getTime()+123),new Date(to.getTime()+456));expect(q.from).toBe(from.toISOString());expect(q.toExclusive).toBe(to.toISOString());
  const plan=f.sqlite.prepare('EXPLAIN QUERY PLAN '+q.sql).all(...q.args).map((r:any)=>r.detail).join(' ');expect(plan).toContain('rss_items_owner_discovered');
 }finally{f.sqlite.close();}
});
it('cannot attribute a mismatched owner subscription even if a legacy corrupt reference exists',async()=>{
 const f=fixture();try{
  f.sqlite.prepare("INSERT INTO rss_items(owner_id,subscription_id,external_id,title,url,published_at,created_at,discovery_kind) VALUES(1,3,'abcdefghijk','bad reference','https://invalid.test/a',0,?,'feed')").run(middle.getTime()/1000);
  expect((await readRssDigest(f.db,1,from,to)).updates.items).toBe(0);
 }finally{f.sqlite.close();}
});
it('bounds displayed channel names while keeping exact totals and explicit omissions',async()=>{
 const f=fixture();try{
  for(let i=4;i<17;i++){
   f.sqlite.prepare("INSERT INTO rss_subscriptions(id,owner_id,title,category,feed_url,source_url) VALUES(?,1,?,'音乐',?,?)").run(i,'频道 '+i,'https://invalid.test/'+i,'https://invalid.test/'+i);
   f.sqlite.prepare("INSERT INTO rss_items(owner_id,subscription_id,external_id,title,url,published_at,created_at,discovery_kind) VALUES(1,?,?,'entry','https://invalid.test/item',0,?,'feed')").run(i,'item-'+i,middle.getTime()/1000);
  }
  const digest=await readRssDigest(f.db,1,from,to);expect(digest.updates).toMatchObject({items:13,channels:13,categories:[{name:'音乐',items:13,channels:13,omittedChannels:3}]});expect(digest.updates.categories[0].listed).toHaveLength(10);expect(rssDigestLines(digest).join('\n')).toContain('另 3 个频道');
 }finally{f.sqlite.close();}
});
it('rejects invalid/unbounded windows and preserves unavailable as an error, never a zero summary',async()=>{
 expect(()=>rssDigestQuery(0,from,to)).toThrow();expect(()=>rssDigestQuery(1,to,from)).toThrow();expect(()=>rssDigestQuery(1,from,new Date(from.getTime()+9*86400000))).toThrow();
 await expect(readRssDigest({prepare(){return{bind(){return this;},all:async()=>({success:false,results:[]})};}} as any,1,from,to)).rejects.toThrow('unavailable');
});
it('rejects hidden extra text, false totals and unsafe channel labels in saved/email projections',async()=>{
 const f=fixture();try{
  const digest=await readRssDigest(f.db,1,from,to);expect(()=>rssDigestValue({...digest,diary:'must never enter'})).toThrow();
  expect(()=>rssDigestValue({...digest,updates:{...digest.updates,items:5}})).toThrow();
  expect(()=>rssDigestValue({...digest,updates:{items:1,channels:1,categories:[{name:'音乐',items:1,channels:1,listed:[{name:'bad\nheader',items:1}],omittedChannels:0}],omittedCategories:0,omittedCategoryItems:0}})).toThrow();
 }finally{f.sqlite.close();}
});
