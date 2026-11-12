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
import {websubSecret} from './websub';
import {createHmac} from 'node:crypto';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');

let service:ReturnType<typeof RssService>;
beforeEach(()=>{
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE rss_write_budget(day TEXT PRIMARY KEY,reserved INTEGER NOT NULL DEFAULT 0); CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2); CREATE TABLE info(key TEXT PRIMARY KEY,value TEXT);');
  for(const file of ['0006-rss-reader.sql','0012-rss-folo-foundation.sql','0013-rss-source-groups.sql','0015-rss-media-gallery.sql','0017-youtube-deduplicate.sql','0020-rss-canonical-video-id.sql','0025-rss-history.sql','0037-rss-discovery-origin.sql']) {
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
  it('renews signed leases through the automation credential without polling or changing feed items',async()=>{
    const env=Container.get<any>(envToken);env.JWT_SECRET='test-only-jwt';
    const body=JSON.stringify({offset:0,limit:5});
    const denied=await service.handle(new Request('http://localhost/rss/sync/renew-websub',{method:'POST',headers:{'content-type':'application/json'},body}));
    expect(denied.status).toBe(401);
    const hub=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(null,{status:202}));
    try {
      const response=await service.handle(new Request('http://localhost/rss/sync/renew-websub',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-only-sync-token'},body}));
      expect(response.status,await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({processed:2,failed:[],hasMore:false,status:{active:2,signed:2,verified:0}});
      expect(hub).toHaveBeenCalledTimes(2);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM rss_items').first()).count).toBe(3);
    } finally {hub.mockRestore();}
  });
  it('rejects forged pushes before writing and accepts signed raw XML without losing read/star state',async()=>{
    const env=Container.get<any>(envToken);env.JWT_SECRET='test-only-jwt';
    await env.DB.prepare('UPDATE rss_subscriptions SET websub_key=? WHERE id=1').bind('v2_test').run();
    const xml='<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><id>yt:video:newvideo123</id><yt:videoId>newvideo123</yt:videoId><title>Signed video</title><link href="https://www.youtube.com/watch?v=newvideo123"/><published>2026-10-30T00:00:00Z</published><author><name>Creator</name></author></entry></feed>';
    const secret=await websubSecret(1,'v2_test','test-only-jwt');
    const signed='sha1='+createHmac('sha1',secret).update(xml).digest('hex');
    const request=(signature?:string,body=xml)=>new Request('http://localhost/rss/websub/1/v2_test',{method:'POST',headers:{'content-type':'application/atom+xml',...(signature?{'x-hub-signature':signature}:{})},body});
    for(const notification of [request(),request('sha1='+'0'.repeat(40)),request(signed,xml+' ')])expect((await service.handle(notification)).status).toBe(403);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM rss_items').first()).count).toBe(3);
    const accepted=await service.handle(request(signed));expect(accepted.status,await accepted.text()).toBe(200);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM rss_items').first()).count).toBe(4);
    expect(await env.DB.prepare('SELECT read,starred FROM rss_items WHERE external_id=?').bind('abcdefghijk').first()).toMatchObject({read:1,starred:1});
  });
  it('accepts and replays history batches without losing read or star state',async()=>{
    const headers={authorization:'Bearer test-only-sync-token','content-type':'application/json'};
    const videos=[{externalId:'abcdefghijk',title:'estimated replacement',publishedAt:0,publishedPrecision:'unknown'}, {externalId:'newvideo123',title:'historical entry',publishedAt:1451606400,publishedPrecision:'estimated'}];
    for(let attempt=0;attempt<2;attempt++) {
      const response=await service.handle(new Request('http://localhost/rss/sync/history-batch',{method:'POST',headers,body:JSON.stringify({subscriptionId:1,videos})}));
      const body=await response.text();
      expect(response.status,body).toBe(200);
      expect(JSON.parse(body)).toMatchObject(attempt===0?{added:1,updated:1}:{added:0,unchanged:2,rowsWritten:0});
    }
    const state=await service.handle(new Request('http://localhost/rss/sync/history-state',{method:'POST',headers,body:JSON.stringify({subscriptionId:1,policy:'full',reason:'test history',status:'complete'})}));
    expect(state.status,await state.text()).toBe(200);
    const sources=await service.handle(new Request('http://localhost/rss/sync/history-sources',{headers}));
    expect(await sources.json()).toMatchObject({sources:expect.arrayContaining([expect.objectContaining({id:1,status:'complete',policy:'full'})])});
    const probe=await service.handle(new Request('http://localhost/rss/sync/history-sources?scope=probe',{headers}));
    expect(await probe.json()).toEqual({sources:[{status:'pending'}]});
    const pending=await service.handle(new Request('http://localhost/rss/sync/history-sources?scope=pending',{headers}));
    expect(await pending.json()).toMatchObject({sources:[{id:2,status:'pending',recent90:0}]});
    const report=await service.handle(new Request('http://localhost/rss/sync/report',{headers}));
    expect(await report.json()).toMatchObject({items:4,duplicates:{groups:0},flags:{read:1,starred:1}});
  });
  it('mounts capability and protected automation routes at their intended paths',async()=>{
    const capability=await service.handle(new Request('http://localhost/rss/capabilities'));
    expect(capability.status).toBe(200); expect(await capability.json()).toMatchObject({version:3});
    const denied=await service.handle(new Request('http://localhost/rss/sync/history-sources'));
    expect(denied.status).toBe(401);
    const probeDenied=await service.handle(new Request('http://localhost/rss/sync/history-sources?scope=probe'));
    expect(probeDenied.status).toBe(401);
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
