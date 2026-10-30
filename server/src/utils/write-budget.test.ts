import {createRequire} from 'node:module';
import {describe,it,expect} from 'vitest';
import {reserveRssWrites,isD1QuotaError,quotaResponse,WriteBudgetError} from './write-budget';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
describe('durable background budget',()=>{
  it('recognizes wrapped driver quota errors without exposing SQL or diagnostics',async()=>{
    const error=new Error('Failed query: private SQL parameters',{cause:new Error('D1_ERROR: Your account has exceeded D1\'s free tier daily row write limit.')});
    expect(isD1QuotaError(error)).toBe(true);
    const response=quotaResponse(error)!;
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
    const text=await response.text();
    expect(text).toContain('D1_QUOTA_PAUSED');expect(text).not.toContain('private SQL');
    const wrappedBudget=quotaResponse(new Error('batch failed',{cause:new WriteBudgetError(Date.now()+60000)}))!;
    expect(await wrappedBudget.json()).toMatchObject({code:'RSS_BUDGET_PAUSED'});
    const cycle=new Error('ordinary database failure');cycle.cause=cycle;
    expect(quotaResponse(cycle)).toBeUndefined();
    expect(isD1QuotaError(new Error('unrelated constraint failure'))).toBe(false);
  });
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
