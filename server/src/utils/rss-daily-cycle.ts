import type {D1Database} from '@cloudflare/workers-types';
import {reserveRssWrites} from './write-budget';

const runKeyPattern=/^[0-9]{1,30}-[0-9]{1,10}$/;
export function rssDay(now:Date){
  if(!Number.isFinite(now.getTime()))throw Error('Invalid RSS cycle time');
  return new Date(now.getTime()+8*3600000).toISOString().slice(0,10);
}
export type RssCaptureStatus={day:string;state:'missing'|'running'|'complete'|'partial'|'timed-out';expected:number|null;succeeded:number|null;finishedAt:string|null;wait:boolean};
export function rssStatusValue(value:RssCaptureStatus):RssCaptureStatus{
  if(!value||!/^\d{4}-\d{2}-\d{2}$/.test(value.day)||!['missing','running','complete','partial','timed-out'].includes(value.state)||typeof value.wait!=='boolean'||
    ![value.expected,value.succeeded].every(v=>v===null||(Number.isSafeInteger(v)&&v>=0&&v<=5000))||
    (value.expected===null)!==(value.succeeded===null)||(value.expected!==null&&value.succeeded!>value.expected)||
    (value.finishedAt!==null&&(!Number.isFinite(Date.parse(value.finishedAt))||rssDay(new Date(value.finishedAt))!==value.day)))throw Error('Invalid RSS capture status');
  return {day:value.day,state:value.state,expected:value.expected,succeeded:value.succeeded,finishedAt:value.finishedAt,wait:value.wait};
}
/** Append after the snapshot INSERT in the same D1 transaction. changes()>0
 * excludes old periods/conflict losers, preserving first-snapshot provenance. */
export function rssCaptureStatement(db:D1Database,owner:number,kind:string,start:number,end:number,sha:string,status:RssCaptureStatus){
 const json=JSON.stringify(rssStatusValue(status));
 return db.prepare(`INSERT INTO life_report_rss_captures(report_id,report_sha256,status_json)
   SELECT id,snapshot_sha256,? FROM life_reports WHERE owner_id=? AND kind=? AND period_start=? AND period_end=? AND snapshot_sha256=? AND template_version=1 AND changes()>0
   ON CONFLICT(report_id) DO NOTHING`).bind(json,owner,kind,start,end,sha);
}
export async function readRssCapture(db:D1Database,owner:number,reportId:number,sha:string){
 const rows=await db.prepare(`SELECT c.status_json FROM life_report_rss_captures c JOIN life_reports r ON r.id=c.report_id
   WHERE r.owner_id=? AND r.id=? AND c.report_sha256=? AND c.report_sha256=r.snapshot_sha256`).bind(owner,reportId,sha).all<{status_json:string}>();
 if(!rows.success)throw Error('RSS capture provenance unavailable');
 return rows.results[0]?rssStatusValue(JSON.parse(rows.results[0].status_json)):undefined;
}

/** No user titles/credentials are stored; admission is once per local day.
 * A lost begin response may safely be retried, but must not start more fetching. */
export async function beginRssCycle(db:D1Database,runKey:string,now=new Date()){
  if(!runKeyPattern.test(runKey))throw Error('Invalid RSS run key');
  const day=rssDay(now),seconds=Math.floor(now.getTime()/1000);
  const prior=await db.prepare('SELECT day FROM rss_daily_cycles WHERE day=?').bind(day).all();
  if(!prior.success)throw Error('RSS cycle read unavailable');
  if(prior.results.length)return {admitted:false,day};
  const sources=await db.prepare("SELECT id FROM rss_subscriptions WHERE active=1 AND platform='youtube' ORDER BY id LIMIT 5001").all<{id:number}>();
  if(!sources.success||sources.results.length>5000)throw Error('RSS cycle source limit');
  const ids=JSON.stringify(sources.results.map(row=>row.id));
  if(ids.length>32768)throw Error('RSS cycle source limit');
  await reserveRssWrites(db,0,false,now.getTime());
  const rows=await db.prepare(`INSERT INTO rss_daily_cycles(day,run_key,started_at,state,source_ids,expected)
    VALUES(?,?,?,'running',?,?) ON CONFLICT(day) DO NOTHING RETURNING day`).bind(day,runKey,seconds,ids,sources.results.length).all();
  if(!rows.success)throw Error('RSS cycle admission unconfirmed');
  // Keep the audit bounded without deleting content or personal records.
  if(rows.results.length){
    const older=rssDay(new Date(now.getTime()-32*86400000));
    const cleanup=await db.prepare('DELETE FROM rss_daily_cycles WHERE day IN (SELECT day FROM rss_daily_cycles WHERE day<? ORDER BY day LIMIT 4)').bind(older).all();
    if(!cleanup.success)throw Error('RSS cycle cleanup unconfirmed');
  }
  return {admitted:rows.results.length===1,day};
}

/** Finish exactly the admitted run. A stale/racing finalizer cannot replace a
 * completed cycle. A removed/failed/skipped source remains visible as partial. */
export async function finishRssCycle(db:D1Database,day:string,runKey:string,workflowSucceeded:boolean,now=new Date()){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!runKeyPattern.test(runKey)||typeof workflowSucceeded!=='boolean')throw Error('Invalid RSS cycle finish');
  const seconds=Math.floor(now.getTime()/1000);rssDay(now);
  const row=await db.prepare("SELECT started_at FROM rss_daily_cycles WHERE day=? AND run_key=? AND state='running'").bind(day,runKey).all<{started_at:number}>();
  if(!row.success)throw Error('RSS cycle read unavailable');
  if(!row.results.length)return {settled:false};
  if(seconds<row.results[0].started_at||seconds-row.results[0].started_at>86400)return {settled:false};
  await reserveRssWrites(db,0,false,now.getTime());
  const result=await db.prepare(`UPDATE rss_daily_cycles SET finished_at=?,succeeded=(
    SELECT COUNT(*) FROM json_each(rss_daily_cycles.source_ids) ids JOIN rss_subscriptions s ON s.id=ids.value
    WHERE s.active=1 AND s.platform='youtube' AND s.last_fetched_at>=rss_daily_cycles.started_at AND s.last_error=''),
    state=CASE WHEN ?=1 AND expected=(SELECT COUNT(*) FROM json_each(rss_daily_cycles.source_ids) ids JOIN rss_subscriptions s ON s.id=ids.value
    WHERE s.active=1 AND s.platform='youtube' AND s.last_fetched_at>=rss_daily_cycles.started_at AND s.last_error='') THEN 'complete' ELSE 'partial' END
    WHERE day=? AND run_key=? AND state='running' RETURNING state,expected,succeeded`).bind(seconds,workflowSucceeded?1:0,day,runKey).all();
  if(!result.success)throw Error('RSS cycle finish unconfirmed');
  return {settled:result.results.length===1};
}

/** 05:00 opens capture; unresolved reconciliation delays it only until 07:30.
 * Read failures fail closed until the deadline, then disclose unavailable data. */
export async function rssCaptureStatus(db:D1Database,now=new Date()):Promise<RssCaptureStatus>{
  const day=rssDay(now),local=new Date(now.getTime()+8*3600000),minute=local.getUTCHours()*60+local.getUTCMinutes();
  const empty={day,state:'missing' as const,expected:null,succeeded:null,finishedAt:null,wait:minute<450};
  try{
    const rows=await db.prepare('SELECT state,expected,succeeded,finished_at FROM rss_daily_cycles WHERE day=?').bind(day).all<{state:'running'|'complete'|'partial';expected:number;succeeded:number;finished_at:number|null}>();
    if(!rows.success)throw Error('RSS cycle read unavailable');
    const row=rows.results[0];if(!row)return empty;
    if(row.state==='running')return {...empty,state:minute>=450?'timed-out':'running',expected:row.expected,succeeded:row.succeeded};
    return {day,state:row.state,expected:row.expected,succeeded:row.succeeded,finishedAt:new Date(row.finished_at!*1000).toISOString(),wait:minute<300};
  }catch{return empty;}
}
