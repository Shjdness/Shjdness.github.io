import {createRequire} from 'node:module';
import {describe,it,expect} from 'vitest';
import {reserveRssWrites} from './write-budget';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
describe('durable background budget',()=>{
  it('atomically rejects competing reservations and resets only on the next UTC day',async()=>{
    const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE rss_write_budget(day TEXT PRIMARY KEY,reserved INTEGER NOT NULL DEFAULT 0)');
    const db={prepare:(sql:string)=>({bind:(...values:any[])=>({all:async()=>({results:sqlite.prepare(sql).all(...values)})})})} as any;
    const now=Date.parse('2026-10-30T23:59:00Z');
    sqlite.prepare('INSERT INTO rss_write_budget VALUES(?,?)').run('rss:2026-10-30',24900);
    const results=await Promise.allSettled([reserveRssWrites(db,3,true,now),reserveRssWrites(db,3,true,now)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(sqlite.prepare('SELECT reserved FROM rss_write_budget').get().reserved).toBeLessThanOrEqual(25000);
    await expect(reserveRssWrites(db,30,true,now+60000)).resolves.toBeUndefined();
    // Daily feeds can still use their reserved headroom after history is paused.
    await expect(reserveRssWrites(db,30,false,now)).resolves.toBeUndefined();
  });
});
