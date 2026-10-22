import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ingestVideos, type VideoRecord } from './ingestion';
import { rssStorage } from './storage';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE rss_items(id INTEGER PRIMARY KEY,owner_id INTEGER,subscription_id INTEGER,external_id TEXT,title TEXT,url TEXT,summary TEXT,author TEXT,embed_url TEXT,thumbnail_url TEXT,published_at INTEGER,published_precision TEXT,read INTEGER DEFAULT 0,starred INTEGER DEFAULT 0,created_at INTEGER,updated_at INTEGER,UNIQUE(owner_id,external_id));
    CREATE TABLE rss_sync_runs(id INTEGER PRIMARY KEY,owner_id INTEGER,source_id INTEGER,kind TEXT,added INTEGER,updated INTEGER,unchanged INTEGER,rows_read INTEGER,rows_written INTEGER,size_before INTEGER,size_after INTEGER,created_at INTEGER);`);
  const prepare = (sql: string) => {
    let bindings: any[]=[];
    return {bind(...values:any[]) {bindings=values;return this;},async all() {
      const results=sqlite.prepare(sql).all(...bindings);
      return {results,meta:{size_after:32768,rows_read:results.length,rows_written:0}};
    },async run() {
      const result=sqlite.prepare(sql).run(...bindings);
      return {results:[],meta:{size_after:32768,rows_read:0,rows_written:Number(result.changes)}};
    }};
  };
  return { sqlite, db:{prepare,async batch(statements:any[]){return Promise.all(statements.map(statement=>statement.run()));}} as any };
}
const video:VideoRecord={externalId:'abcdefghijk',title:'中文标题',summary:'完整简介',author:'作者',url:'',embedUrl:'',thumbnailUrl:'',publishedAt:new Date('2020-01-02T00:00:00Z')};

describe('RSS ingestion against real SQLite SQL',()=>{
  it('is idempotent, skips unchanged writes and preserves read/star flags',async()=>{
    const {db,sqlite}=database(); const source={id:1,ownerId:1};
    expect((await ingestVideos(db,source,[video,video])).added).toBe(1);
    sqlite.exec('UPDATE rss_items SET read=1,starred=1,updated_at=123');
    const second=await ingestVideos(db,source,[video]);
    expect(second).toMatchObject({added:0,updated:0,unchanged:1,rowsWritten:0});
    expect(sqlite.prepare('SELECT read,starred,updated_at FROM rss_items').get()).toMatchObject({read:1,starred:1,updated_at:123});
    expect((await ingestVideos(db,source,[{...video,title:'新标题'}])).updated).toBe(1);
    expect(sqlite.prepare('SELECT read,starred FROM rss_items').get()).toMatchObject({read:1,starred:1});
  });
  it('historical replay never degrades exact dates or rich metadata; isolates owners',async()=>{
    const {db,sqlite}=database();
    await ingestVideos(db,{id:1,ownerId:1},[video]);
    await ingestVideos(db,{id:2,ownerId:2},[{...video,title:'Another owner'}]);
    const replay=await ingestVideos(db,{id:1,ownerId:1},[{...video,title:'Relative listing title',summary:'',publishedAt:new Date('2020-01-01'),publishedPrecision:'estimated'}],'history');
    expect(replay.rowsWritten).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS total FROM rss_items').get().total).toBe(2);
    expect(sqlite.prepare('SELECT title,summary,published_precision FROM rss_items WHERE owner_id=1').get()).toMatchObject({title:'中文标题',summary:'完整简介',published_precision:'exact'});
  });
  it('measures UTF-8 bytes and real backend size without inventing a quota',async()=>{
    const {db}=database(); await ingestVideos(db,{id:1,ownerId:1},[video]);
    const sample=await rssStorage(db,1);
    expect(sample.backend).toMatchObject({usedBytes:32768,limitBytes:null,measured:true});
    expect(sample.rssBytes).toBeGreaterThan(video.title.length+video.summary.length);
    expect(sample.items).toBe(1);
  });
});
