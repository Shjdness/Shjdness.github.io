import 'reflect-metadata';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/d1';
import Container from 'typedi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../db/schema';
import { dbToken, envToken } from '../../utils/di';
vi.mock('../../setup',async()=>{const {default:Elysia}=await import('elysia');return {setup:()=>new Elysia({name:'test-setup',aot:false}).derive({as:'global'},()=>({uid:1,lifeAccess:true}))};});
import { RssService } from './routes';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');

let service:ReturnType<typeof RssService>;
beforeEach(()=>{
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2); CREATE TABLE info(key TEXT PRIMARY KEY,value TEXT);');
  for(const file of ['0006-rss-reader.sql','0012-rss-folo-foundation.sql','0013-rss-source-groups.sql','0015-rss-media-gallery.sql','0017-youtube-deduplicate.sql','0020-rss-canonical-video-id.sql','0025-rss-history.sql']) {
    sqlite.exec(readFileSync(new URL(`../../../sql/${file}`,import.meta.url),'utf8'));
    if(file.startsWith('0006')) sqlite.exec('ALTER TABLE rss_items ADD COLUMN read_at INTEGER; ALTER TABLE rss_items ADD COLUMN starred_at INTEGER;');
    if(file.startsWith('0015')) sqlite.exec("ALTER TABLE rss_subscriptions ADD COLUMN websub_key TEXT DEFAULT '' NOT NULL; ALTER TABLE rss_subscriptions ADD COLUMN websub_callback TEXT DEFAULT '' NOT NULL; ALTER TABLE rss_subscriptions ADD COLUMN websub_lease_expires_at INTEGER;");
  }
  sqlite.exec(`INSERT INTO rss_subscriptions(id,owner_id,platform,feed_url,title,external_id) VALUES(1,1,'youtube','https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxxxxxxxxxxxxxxxxxx','Creator','UCxxxxxxxxxxxxxxxxxxxxxx'),(2,2,'youtube','https://www.youtube.com/feeds/videos.xml?channel_id=UCyyyyyyyyyyyyyyyyyyyyyy','Other','UCyyyyyyyyyyyyyyyyyyyyyy');
  INSERT INTO rss_items(owner_id,subscription_id,external_id,title,url,summary,published_at,read,starred) VALUES(1,1,'abcdefghijk','100% 完成','https://youtube.com/watch?v=abcdefghijk','仅简介出现keyword',1546300800,1,1),(1,1,'lmnopqrstuv','新记录','https://youtube.com/watch?v=lmnopqrstuv','',1735689600,0,0),(2,2,'zyxwvutsrqp','100% 其他账户','https://youtube.com/watch?v=zyxwvutsrqp','',1546300800,0,0);`);
  const prepare=(sql:string)=>{
    let values:any[]=[];
    return {bind(...args:any[]){values=args;return this;},async all(){const results=sqlite.prepare(sql).all(...values);return {results,meta:{size_after:131072,rows_read:results.length,rows_written:0}};},async raw(){return sqlite.prepare(sql).all(...values).map((row:any)=>Object.values(row));},async first(){return sqlite.prepare(sql).get(...values) || null;},async run(){const result=sqlite.prepare(sql).run(...values);return {results:[],meta:{size_after:131072,rows_read:0,rows_written:Number(result.changes)}};}};
  };
  const raw={prepare,async batch(statements:any[]){return Promise.all(statements.map(statement=>statement.run()));}} as any;
  Container.set(dbToken,drizzle(raw,{schema}));
  Container.set(envToken,{DB:raw,RSS_SYNC_TOKEN:'test-only-sync-token'} as any);
  service=RssService();
});

describe('RSS routes and actual query composition',()=>{
  it('mounts capability and protected automation routes at their intended paths',async()=>{
    const capability=await service.handle(new Request('http://localhost/rss/capabilities'));
    expect(capability.status).toBe(200); expect(await capability.json()).toMatchObject({version:3});
    const denied=await service.handle(new Request('http://localhost/rss/sync/history-sources'));
    expect(denied.status).toBe(401);
    const report=await service.handle(new Request('http://localhost/rss/sync/report',{headers:{authorization:'Bearer test-only-sync-token'}}));
    const reportText=await report.text();
    expect(report.status,reportText).toBe(200);
    expect(JSON.parse(reportText)).toMatchObject({items:3,duplicates:{groups:0}});
  });
  it('combines channel/year/literal search with owner isolation and stable counts',async()=>{
    for(const q of ['100%','keyword']) {
      const response=await service.handle(new Request(`http://localhost/rss?sourceId=1&year=2019&q=${encodeURIComponent(q)}`));
      expect(response.status).toBe(200);
      const data=await response.json() as {items:Array<{externalId:string}>;page:{total:number};counts:{all:number};years:string[]};
      expect(data.items).toHaveLength(1); expect(data.items[0].externalId).toBe('abcdefghijk');
      expect(data.page.total).toBe(1); expect(data.counts.all).toBe(2);
      expect(data.years).toContain('2019');
    }
  });
});
