import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {runReportSchedule,processReportJob} from './report-jobs';
import {beginRssCycle,finishRssCycle} from './rss-daily-cycle';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
const monday=new Date('2026-11-02T00:00:00Z');

function fixture(){
  const sqlite=new DatabaseSync(':memory:'),folder=new URL('../../sql/',import.meta.url);
  for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort()){
    sqlite.exec(readFileSync(new URL(file,folder),'utf8'));if(file==='0002.sql')sqlite.exec('ALTER TABLE feeds ADD COLUMN top INTEGER DEFAULT 0');
  }
  sqlite.exec("INSERT INTO users(id,username,openid,permission) VALUES(1,'owner','owner',1),(2,'other','other',1),(3,'trusted','trusted',2); INSERT INTO life_report_preferences(owner_id) VALUES(1),(2),(3)");
  let tail=Promise.resolve();
  const raw={prepare(sql:string){let values:unknown[]=[];return {bind(...args:unknown[]){values=args;return this;},async all(){return {success:true,results:sqlite.prepare(sql).all(...values),meta:{}};}};},batch(statements:Array<{all:()=>Promise<unknown>}>){
    const next=tail.then(async()=>{sqlite.exec('BEGIN');try{const rows=[];for(const statement of statements)rows.push(await statement.all());sqlite.exec('COMMIT');return rows;}catch(error){sqlite.exec('ROLLBACK');throw error;}});tail=next.then(()=>{},()=>{});return next;
  }} as any;
  return {sqlite,raw};
}

it('actual RSS gate delays new snapshots through refresh and releases at completion or 07:30 without replay',async()=>{
 const f=fixture();try{
  const start=new Date('2026-11-03T20:15:00Z'),five=new Date('2026-11-03T21:00:00Z'),options={waitForRss:true};
  f.sqlite.exec('UPDATE life_report_preferences SET daily_enabled=1 WHERE owner_id=1');
  expect(await runReportSchedule(f.raw,five,options)).toMatchObject({queued:0,processed:0});
  await beginRssCycle(f.raw,'10-1',start);
  expect(await runReportSchedule(f.raw,five,options)).toMatchObject({queued:0,processed:0});
  await finishRssCycle(f.raw,'2026-11-04','10-1',true,five);
  expect(await runReportSchedule(f.raw,five,options)).toMatchObject({queued:1,processed:1});
  expect(JSON.parse(f.sqlite.prepare('SELECT status_json FROM life_report_rss_captures').get().status_json)).toMatchObject({state:'complete',wait:false});
  const json=f.sqlite.prepare('SELECT snapshot_json FROM life_reports').get().snapshot_json;
  expect(await runReportSchedule(f.raw,new Date('2026-11-03T23:30:00Z'),options)).toMatchObject({queued:0,processed:0});
  expect(f.sqlite.prepare('SELECT snapshot_json FROM life_reports').get().snapshot_json).toBe(json);
  expect(await runReportSchedule(f.raw,new Date('2026-11-04T23:29:59Z'),options)).toMatchObject({queued:0});
  expect(await runReportSchedule(f.raw,new Date('2026-11-04T23:30:00Z'),options)).toMatchObject({queued:1,processed:1});
  expect(f.sqlite.prepare('SELECT count(*) n FROM life_reports').get().n).toBe(2);
  const captures=f.sqlite.prepare('SELECT status_json FROM life_report_rss_captures ORDER BY report_id').all();expect(captures).toHaveLength(2);expect(JSON.parse(captures[1].status_json)).toMatchObject({state:'missing',wait:false});
 }finally{f.sqlite.close();}
});

it('keeps inactive cron ticks read-only and generates one frozen combined Monday occurrence without external calls',async()=>{
  const f=fixture(),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  try{
    const before=f.sqlite.prepare('SELECT total_changes() AS n').get().n;
    for(let tick=0;tick<12;tick++)expect(await runReportSchedule(f.raw,new Date(monday.getTime()+tick*300000))).toEqual({owners:0,queued:0,processed:0});
    expect(f.sqlite.prepare('SELECT total_changes() AS n').get().n).toBe(before);
    f.sqlite.exec("UPDATE life_report_preferences SET daily_enabled=1,weekly_enabled=1 WHERE owner_id IN(1,3)");
    expect(await runReportSchedule(f.raw,monday)).toMatchObject({owners:1,queued:1,processed:1});
    const first=f.sqlite.prepare('SELECT * FROM life_report_jobs').get();expect(first).toMatchObject({owner_id:1,kind:'weekly',include_daily:1,state:'ready',attempts:1});
    expect(first.report_id).not.toBe(first.daily_report_id);expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_reports').get()).toMatchObject({n:2});
    const snapshots=JSON.stringify(f.sqlite.prepare('SELECT * FROM life_reports').all());
    f.sqlite.exec("INSERT INTO life_todos(owner_id,content,type,completed,completed_at) VALUES(1,'later source fixture','success',1,1793548800)");
    expect(await runReportSchedule(f.raw,new Date(monday.getTime()+300000))).toMatchObject({queued:0,processed:0});
    expect(JSON.stringify(f.sqlite.prepare('SELECT * FROM life_reports').all())).toBe(snapshots);expect(fetcher).not.toHaveBeenCalled();
  }finally{vi.unstubAllGlobals();f.sqlite.close();}
});

it('recovers abandoned generation using the fixed old period, without changing first snapshots or leaking owners',async()=>{
  const f=fixture();try{
    f.sqlite.exec('UPDATE life_report_preferences SET daily_enabled=1,weekly_enabled=1 WHERE owner_id=1');
    await runReportSchedule(f.raw,monday);
    const original=f.sqlite.prepare('SELECT * FROM life_report_jobs').get();
    f.sqlite.prepare("UPDATE life_report_jobs SET state='generating',attempts=1,lease_token='abandoned',lease_until=?,report_id=NULL,daily_report_id=NULL").run(monday.getTime()/1000+60);
    const nextDay=new Date('2026-11-02T16:05:00Z');
    await runReportSchedule(f.raw,nextDay);
    const recovered=f.sqlite.prepare('SELECT * FROM life_report_jobs WHERE job_key=?').get(original.job_key);
    expect(recovered).toMatchObject({state:'ready',attempts:2,report_id:original.report_id,daily_report_id:original.daily_report_id,period_start:original.period_start});
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_reports WHERE owner_id=2').get()).toMatchObject({n:0});
  }finally{f.sqlite.close();}
});

it('bounds generation failures and honors disabled settings or revoked roles before materializing',async()=>{
  const f=fixture();try{
    f.sqlite.exec("UPDATE life_report_preferences SET daily_enabled=1 WHERE owner_id=1; CREATE TRIGGER fixture_generation_abort BEFORE INSERT ON life_reports BEGIN SELECT RAISE(ABORT,'fixture generation interrupted'); END");
    await runReportSchedule(f.raw,monday);
    expect(f.sqlite.prepare('SELECT state,attempts FROM life_report_jobs').get()).toMatchObject({state:'queued',attempts:1});
    await runReportSchedule(f.raw,new Date(monday.getTime()+300000));await runReportSchedule(f.raw,new Date(monday.getTime()+600000));
    expect(f.sqlite.prepare('SELECT state,attempts FROM life_report_jobs').get()).toMatchObject({state:'failed',attempts:3});
    await runReportSchedule(f.raw,new Date(monday.getTime()+900000));expect(f.sqlite.prepare('SELECT attempts FROM life_report_jobs').get()).toMatchObject({attempts:3});
    f.sqlite.exec("DROP TRIGGER fixture_generation_abort; UPDATE life_report_jobs SET state='queued',attempts=0,next_attempt_at=0; UPDATE users SET permission=2 WHERE id=1");
    const row=f.sqlite.prepare('SELECT * FROM life_report_jobs').get();
    expect(await processReportJob(f.raw,row,monday)).toBe(true);
    expect(f.sqlite.prepare('SELECT state,error_code FROM life_report_jobs').get()).toMatchObject({state:'paused',error_code:'disabled'});
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_reports').get()).toMatchObject({n:0});
  }finally{f.sqlite.close();}
});

it('rotates a bounded owner cursor and uses indexes rather than starving later enabled owners',async()=>{
  const f=fixture();try{
    for(let id=4;id<=14;id++){f.sqlite.prepare('INSERT INTO users(id,username,openid,permission) VALUES(?,?,?,1)').run(id,'fixture','fixture'+id);f.sqlite.prepare('INSERT INTO life_report_preferences(owner_id,daily_enabled) VALUES(?,1)').run(id);}
    expect((await runReportSchedule(f.raw,monday)).owners).toBe(8);
    expect((await runReportSchedule(f.raw,monday)).owners).toBe(3);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_jobs').get()).toMatchObject({n:11});
    const plan=f.sqlite.prepare("EXPLAIN QUERY PLAN SELECT job_key FROM life_report_jobs WHERE state='queued' AND next_attempt_at<=? LIMIT 3").all(monday.getTime()/1000).map((r:any)=>r.detail).join(' ');
    expect(plan).toContain('life_report_jobs_due');
  }finally{f.sqlite.close();}
});


it('observes a pause during generation and excludes expired owners before queueing',async()=>{
  const f=fixture();try{
    f.sqlite.exec('UPDATE life_report_preferences SET daily_enabled=1 WHERE owner_id IN (1,2)');
    f.sqlite.prepare('UPDATE users SET access_expires_at=? WHERE id=2').run(monday.getTime()/1000-1);
    const original=f.raw.batch;let once=false;
    f.raw.batch=async(statements:any[])=>{const rows=await original(statements);if(!once){once=true;f.sqlite.exec('UPDATE life_report_preferences SET daily_enabled=0 WHERE owner_id=1');}return rows;};
    await runReportSchedule(f.raw,monday);
    expect(f.sqlite.prepare('SELECT owner_id,state,error_code FROM life_report_jobs').all()).toEqual([expect.objectContaining({owner_id:1,state:'paused',error_code:'disabled'})]);
    f.sqlite.exec('UPDATE life_report_preferences SET daily_enabled=1 WHERE owner_id=1');
    expect((await runReportSchedule(f.raw,new Date(monday.getTime()+300000))).processed).toBe(0);
  }finally{f.sqlite.close();}
});


it('changing the weekly weekday does not resend the old weekly occurrence or swallow the next daily report',async()=>{
  const f=fixture();try{
    f.sqlite.exec('UPDATE life_report_preferences SET daily_enabled=1,weekly_enabled=1 WHERE owner_id=1');
    await runReportSchedule(f.raw,monday);
    f.sqlite.exec('UPDATE life_report_preferences SET weekly_day=2 WHERE owner_id=1');
    await runReportSchedule(f.raw,new Date('2026-11-03T00:00:00Z'));
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM life_report_jobs WHERE kind='weekly'").get()).toMatchObject({n:1});
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM life_report_jobs WHERE kind='daily' AND state='ready'").get()).toMatchObject({n:1});
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_reports').get()).toMatchObject({n:3});
  }finally{f.sqlite.close();}
});
