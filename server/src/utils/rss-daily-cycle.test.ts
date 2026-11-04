import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {beginRssCycle,finishRssCycle,rssCaptureStatus,rssDay} from './rss-daily-cycle';
import {cycleRoutes} from '../services/rss/cycle';
import {runRequestContext} from './di';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
const start=new Date('2026-11-03T20:15:00Z'),five=new Date('2026-11-03T21:00:00Z'),deadline=new Date('2026-11-03T23:30:00Z');
function fixture(){
 const sqlite=new DatabaseSync(':memory:'),folder=new URL('../../sql/',import.meta.url);
 for(const file of readdirSync(folder).filter(s=>s.endsWith('.sql')).sort()){sqlite.exec(readFileSync(new URL(file,folder),'utf8'));if(file==='0002.sql')sqlite.exec('ALTER TABLE feeds ADD COLUMN top INTEGER DEFAULT 0');}
 sqlite.exec("INSERT INTO users(id,username,openid,permission) VALUES(1,'test','test',1); INSERT INTO rss_subscriptions(id,owner_id,feed_url,source_url,platform) VALUES(1,1,'https://invalid.test/feed1','https://invalid.test/1','youtube'),(2,1,'https://invalid.test/feed2','https://invalid.test/2','youtube')");
 const db={prepare(sql:string){let args:unknown[]=[];return {bind(...values:unknown[]){args=values;return this;},async all(){return {success:true,results:sqlite.prepare(sql).all(...args)};}};}} as any;
 return {sqlite,db};
}
it('claims one local-day reconciliation across five concurrent starts and workflow reruns',async()=>{
 const f=fixture();try{
  expect(rssDay(start)).toBe('2026-11-04');
  const results=await Promise.all(Array.from({length:5},(_,i)=>beginRssCycle(f.db,`${i+10}-1`,start)));
  expect(results.filter(r=>r.admitted)).toHaveLength(1);expect(f.sqlite.prepare('SELECT state,expected,source_ids FROM rss_daily_cycles').get()).toMatchObject({state:'running',expected:2,source_ids:'[1,2]'});
  const before=f.sqlite.prepare('SELECT total_changes() n').get().n;
  expect((await beginRssCycle(f.db,'99-2',start)).admitted).toBe(false);expect(f.sqlite.prepare('SELECT total_changes() n').get().n).toBe(before);
 }finally{f.sqlite.close();}
});
it('counts only freshly fetched successful sources and makes partial/final settlement immutable',async()=>{
 const f=fixture();try{
  await beginRssCycle(f.db,'10-1',start);
  f.sqlite.prepare("UPDATE rss_subscriptions SET last_fetched_at=?,last_error='' WHERE id=1").run(start.getTime()/1000+60);
  f.sqlite.prepare("UPDATE rss_subscriptions SET last_fetched_at=?,last_error='' WHERE id=2").run(start.getTime()/1000-1);
  expect(await finishRssCycle(f.db,'2026-11-04','wrong',true,five).catch(()=>null)).toBeNull();
  expect(await finishRssCycle(f.db,'2026-11-04','11-1',true,five)).toEqual({settled:false});
  expect(await finishRssCycle(f.db,'2026-11-04','10-1',true,five)).toEqual({settled:true});
  expect(await rssCaptureStatus(f.db,five)).toMatchObject({state:'partial',expected:2,succeeded:1,wait:false});
  f.sqlite.prepare("UPDATE rss_subscriptions SET last_fetched_at=?,last_error=''").run(five.getTime()/1000);
  expect(await finishRssCycle(f.db,'2026-11-04','10-1',true,deadline)).toEqual({settled:false});
  expect((await rssCaptureStatus(f.db,deadline)).state).toBe('partial');
 }finally{f.sqlite.close();}
});
it('waits on absent/running cycles from 05:00, stops at 07:30, and ignores yesterday completion',async()=>{
 const f=fixture();try{
  expect(await rssCaptureStatus(f.db,five)).toMatchObject({state:'missing',wait:true});
  expect(await rssCaptureStatus(f.db,deadline)).toMatchObject({state:'missing',wait:false});
  await beginRssCycle(f.db,'10-1',start);
  expect(await rssCaptureStatus(f.db,new Date(deadline.getTime()-1))).toMatchObject({state:'running',wait:true});
  expect(await rssCaptureStatus(f.db,deadline)).toMatchObject({state:'timed-out',wait:false});
  const tomorrow=new Date(five.getTime()+86400000);expect(await rssCaptureStatus(f.db,tomorrow)).toMatchObject({state:'missing',wait:true});
 }finally{f.sqlite.close();}
});
it('does not capture before 05:00 even if RSS completed, including empty source sets',async()=>{
 const f=fixture();try{
  f.sqlite.exec('UPDATE rss_subscriptions SET active=0');await beginRssCycle(f.db,'10-1',start);await finishRssCycle(f.db,'2026-11-04','10-1',true,new Date(start.getTime()+60000));
  expect(await rssCaptureStatus(f.db,start)).toMatchObject({state:'complete',expected:0,succeeded:0,wait:true});
  expect(await rssCaptureStatus(f.db,five)).toMatchObject({state:'complete',wait:false});
 }finally{f.sqlite.close();}
});
it('does not describe transport/setup failure as a complete refresh even with all fresh sources',async()=>{
 const f=fixture();try{
  await beginRssCycle(f.db,'10-1',start);f.sqlite.prepare("UPDATE rss_subscriptions SET last_fetched_at=?,last_error=''").run(start.getTime()/1000+1);
  await finishRssCycle(f.db,'2026-11-04','10-1',false,five);expect(await rssCaptureStatus(f.db,five)).toMatchObject({state:'partial',expected:2,succeeded:2,wait:false});
 }finally{f.sqlite.close();}
});
it('bounds cleanup/source admission and fails safely during database read failure without a write',async()=>{
 const prepare=vi.fn((_sql:string)=>({bind(){return this;},all:async()=>{throw Error('private backend failure');}}));
 expect(await rssCaptureStatus({prepare} as any,five)).toMatchObject({state:'missing',wait:true});
 expect(await rssCaptureStatus({prepare} as any,deadline)).toMatchObject({state:'missing',wait:false});
 expect(prepare.mock.calls.every(([sql])=>String(sql).startsWith('SELECT'))).toBe(true);
 const f=fixture();try{
  f.sqlite.exec("INSERT INTO rss_daily_cycles(day,run_key,started_at,state,source_ids,expected) VALUES('2026-01-01','1-1',0,'running','[]',0)");
  await beginRssCycle(f.db,'10-1',start);expect(f.sqlite.prepare('SELECT count(*) n FROM rss_daily_cycles').get().n).toBe(1);
 }finally{f.sqlite.close();}
});
it('rejects anonymous and wrong-token lifecycle requests before accessing the database',async()=>{
 const prepare=vi.fn(()=>{throw Error('must not access');}),service=cycleRoutes(value=>value==='Bearer synthetic');
 for(const path of ['begin','finish'])for(const authorization of [undefined,'Bearer incorrect']){
  const body=path==='begin'?{runKey:'10-1'}:{runKey:'10-1',day:'2026-11-04',succeeded:true};
  const response=await runRequestContext({DB:{prepare}} as any,{} as any,()=>service.handle(new Request('http://localhost/sync/cycle/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(authorization?{Authorization:authorization}:{})},body:JSON.stringify(body)})));
  expect(response.status).toBe(401);expect(response.headers.get('cache-control')).toContain('no-store');
 }
 expect(prepare).not.toHaveBeenCalled();
});
