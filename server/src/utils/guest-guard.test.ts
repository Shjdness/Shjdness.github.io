import {createRequire} from 'node:module';
import {it,expect} from 'vitest';
import {reserveGuestAttempt,GuestLimitError} from './guest-guard';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
it('limits parallel attempts across isolates, resets the window and bounds global login writes',async()=>{
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE info(key TEXT UNIQUE NOT NULL,value TEXT NOT NULL);CREATE TABLE rss_write_budget(day TEXT PRIMARY KEY,reserved INTEGER NOT NULL DEFAULT 0)');
  const db={prepare(sql:string){return {bind(...values:unknown[]){return {async all(){return {results:sqlite.prepare(sql).all(...values)};}};}};}} as any;
  const now=Date.parse('2026-10-30T12:00:00Z');
  const results=await Promise.allSettled(Array.from({length:12},()=>reserveGuestAttempt(db,'fixture-ip',now)));
  expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(5);
  expect(results.filter(row=>row.status==='rejected' && row.reason instanceof GuestLimitError)).toHaveLength(7);
  await expect(reserveGuestAttempt(db,'fixture-ip',now+15*60*1000)).resolves.toBeUndefined();
  sqlite.prepare('UPDATE rss_write_budget SET reserved=1600').run();
  await expect(reserveGuestAttempt(db,'other-ip',now)).rejects.toBeInstanceOf(GuestLimitError);
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM info').get().n).toBe(1);
  expect(sqlite.prepare('SELECT value FROM info').get().value).not.toContain('fixture-ip');
  sqlite.close();
});
