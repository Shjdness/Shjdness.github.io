import type {D1Database} from '@cloudflare/workers-types';
import {dueReportOccurrence,REPORT_CAPTURE_TIME} from './report-schedule';
import {reportDigest} from './report-analysis-format';
import {reportWindow,type ReportKind} from './life-report';
import {findReportForPeriod,saveReportSnapshot} from './report-history';
import {previewLifeReportPeriod} from './report-data';
import {reserveReportWrite} from './report-settings';
import type {CheckinVault} from './checkin-vault';
import {saveReportWithCheckins} from './report-checkin-snapshot';
import {rssCaptureStatus,type RssCaptureStatus} from './rss-daily-cycle';

export async function listReportJobs(db:D1Database,ownerId:number){
  const rows=await db.prepare('SELECT kind,period_start,period_end,state,attempts,report_id,daily_report_id,error_code,created_at,updated_at FROM life_report_jobs WHERE owner_id=? ORDER BY created_at DESC,job_key LIMIT 10').bind(ownerId).all();
  if(!rows.success)throw Error('Report jobs unavailable');return rows.results;
}

type Job={job_key:string;owner_id:number;kind:ReportKind;period_start:number;period_end:number;anchor_at:number;include_daily:number;state:string;attempts:number;lease_until:number|null};
type Active={owner_id:number;daily_enabled:number;weekly_enabled:number;daily_time:string;weekly_time:string;weekly_day:number};
const eligible=`p.owner_id=u.id AND u.permission=1 AND (u.access_expires_at IS NULL OR u.access_expires_at>?)`;

async function enabledForJob(db:D1Database,job:Job,seconds:number){
  const rows=await db.prepare(`SELECT p.daily_enabled,p.weekly_enabled FROM life_report_preferences p JOIN users u ON ${eligible} WHERE p.owner_id=?`).bind(seconds,job.owner_id).all<{daily_enabled:number;weekly_enabled:number}>();
  if(!rows.success)throw Error('Report permission read unavailable');
  const p=rows.results[0];return Boolean(p&&(job.kind==='weekly'?p.weekly_enabled===1:p.daily_enabled===1)&&(!job.include_daily||p.daily_enabled===1));
}

/** Only safe, idempotent statistics generation is retried. No AI/provider call
 * or mail submission occurs under this reclaimable generation lease. */
export async function processReportJob(db:D1Database,job:Job,now=new Date(),options:{checkins?:CheckinVault;rss?:RssCaptureStatus}={}){
  const seconds=Math.floor(now.getTime()/1000),token=crypto.randomUUID();
  if(!await reserveReportWrite(db))return false;
  const claim=await db.prepare(`UPDATE life_report_jobs SET state='generating',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=?
    WHERE job_key=? AND attempts<3 AND ((state='queued' AND next_attempt_at<=?) OR (state='generating' AND lease_until<=?)) RETURNING job_key,attempts`).bind(token,seconds+120,seconds,job.job_key,seconds,seconds).all();
  if(!claim.success)throw Error('Report job claim unconfirmed');if(!claim.results.length)return false;
  const attempt=Number(claim.results[0].attempts);
  const settle=async(state:string,error:string|null,reportId:number|null=null,dailyId:number|null=null)=>{
    const result=await db.prepare(`UPDATE life_report_jobs SET state=?,error_code=?,report_id=?,daily_report_id=?,lease_token=NULL,lease_until=NULL,next_attempt_at=?,updated_at=?
      WHERE job_key=? AND state='generating' AND lease_token=? RETURNING job_key`).bind(state,error,reportId,dailyId,seconds+300,seconds,job.job_key,token).all();
    if(!result.success||result.results.length!==1)throw Error('Report job settlement unconfirmed');
  };
  try{
    const period=reportWindow(job.kind,new Date(job.anchor_at*1000));
    const raw=`report-schedule:v1:${job.owner_id}:${job.kind}:${period.start}:${period.end}`;
    if(job.job_key!==await reportDigest(raw)||Date.parse(period.start)/1000!==job.period_start||Date.parse(period.end)/1000!==job.period_end||!Number.isSafeInteger(job.owner_id)||job.owner_id<=0){await settle('failed','invalid-job');return true;}
    if(!await enabledForJob(db,job,seconds)){await settle('paused','disabled');return true;}
    const snapshot=async(kind:ReportKind)=>{
      const window=reportWindow(kind,new Date(job.anchor_at*1000));
      const previous=await findReportForPeriod(db,job.owner_id,window);
      return previous??(options.checkins?saveReportWithCheckins(db,options.checkins,job.owner_id,window,now,options.rss):saveReportSnapshot(db,job.owner_id,await previewLifeReportPeriod(db,job.owner_id,window,now),options.rss));
    };
    const primary=await snapshot(job.kind),daily=job.include_daily?await snapshot('daily'):null;
    // Pauses/role revocation during computation must prevent a ready delivery.
    if(!await enabledForJob(db,job,Math.max(seconds,Math.floor(Date.now()/1000)))){await settle('paused','disabled');return true;}
    await settle('ready',null,primary.id,daily?.id??null);
  }catch{
    // No provider diagnostic/free-text error is stored or logged. If this
    // settlement itself fails, the lease safely expires and is bounded by 3 attempts.
    await settle(attempt>=3?'failed':'queued','generation-unavailable');
  }
  return true;
}

/** One bounded cron tick: keyset-rotate up to 8 enabled owners, process at most
 * 3 queued generations. Existing occurrences and inactive settings cause no writes. */
export async function runReportSchedule(db:D1Database,now=new Date(),options:{checkins?:CheckinVault;waitForRss?:boolean}={}){
  const seconds=Math.floor(now.getTime()/1000);
  if(!Number.isSafeInteger(seconds)||seconds<0)throw Error('Invalid schedule time');
  // The actual worker enables this gate. Existing snapshots/AI/mail are not
  // stalled by it: those continue independently after this function returns.
  const rss=options.waitForRss?await rssCaptureStatus(db,now):undefined;
  if(rss?.wait)return {owners:0,queued:0,processed:0};
  const cursorRows=await db.prepare('SELECT owner_cursor FROM life_report_scheduler_state WHERE id=1').all<{owner_cursor:number}>();
  if(!cursorRows.success)throw Error('Report cursor unavailable');
  const cursor=cursorRows.results[0]?.owner_cursor??0;
  const select=async(after:number)=>{
    const rows=await db.prepare(`SELECT p.owner_id,p.daily_enabled,p.weekly_enabled,p.daily_time,p.weekly_time,p.weekly_day FROM life_report_preferences p JOIN users u ON ${eligible}
      WHERE (p.daily_enabled=1 OR p.weekly_enabled=1) AND p.owner_id>? ORDER BY p.owner_id LIMIT 8`).bind(seconds,after).all<Active>();
    if(!rows.success)throw Error('Report schedule unavailable');return rows.results;
  };
  let preferences=await select(cursor);if(!preferences.length&&cursor>0)preferences=await select(0);
  let queued=0,processed=0;
  for(const p of preferences){
    let due=dueReportOccurrence({ownerId:p.owner_id,dailyEnabled:p.daily_enabled===1,weeklyEnabled:p.weekly_enabled===1,dailyTime:p.daily_time,weeklyTime:p.weekly_time,weeklyDay:p.weekly_day},now,{captureTime:REPORT_CAPTURE_TIME});
    if(!due)continue;
    let key=await reportDigest(due.occurrenceKey);
    const lookup=async(jobKey:string)=>{
      const rows=await db.prepare('SELECT job_key,anchor_at FROM life_report_jobs WHERE job_key=?').bind(jobKey).all<{job_key:string;anchor_at:number}>();
      if(!rows.success)throw Error('Report occurrence unavailable');return rows.results[0];
    };
    let existing=await lookup(key);
    // Moving the weekly day after this week's report already exists must not
    // swallow a different day's daily report or resend that weekly report.
    if(existing&&due.kind==='weekly'&&due.includeDaily&&reportWindow('daily',new Date(existing.anchor_at*1000)).start!==reportWindow('daily',now).start){
      due=dueReportOccurrence({ownerId:p.owner_id,dailyEnabled:true,weeklyEnabled:false,dailyTime:p.daily_time,weeklyTime:p.weekly_time,weeklyDay:p.weekly_day},now,{captureTime:REPORT_CAPTURE_TIME});
      if(!due)continue;
      key=await reportDigest(due.occurrenceKey);existing=await lookup(key);
    }
    if(existing)continue;
    if(!await reserveReportWrite(db))break;
    const inserted=await db.prepare(`INSERT INTO life_report_jobs(job_key,owner_id,kind,period_start,period_end,anchor_at,include_daily,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING job_key`).bind(key,due.ownerId,due.kind,Date.parse(due.period.start)/1000,Date.parse(due.period.end)/1000,Date.parse(due.scheduledAt)/1000,due.includeDaily?1:0,seconds,seconds).all();
    if(!inserted.success)throw Error('Report queue unconfirmed');queued+=inserted.results.length;
  }
  const next=preferences.length===8?preferences[preferences.length-1].owner_id:0;
  if(next!==cursor&&await reserveReportWrite(db)){
    const result=await db.prepare(`INSERT INTO life_report_scheduler_state(id,owner_cursor) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET owner_cursor=excluded.owner_cursor WHERE owner_cursor=?`).bind(next,cursor).all();
    if(!result.success)throw Error('Report cursor save unconfirmed');
  }
  const pending=await db.prepare(`SELECT * FROM life_report_jobs WHERE attempts<3 AND ((state='queued' AND next_attempt_at<=?) OR (state='generating' AND lease_until<=?)) ORDER BY created_at,job_key LIMIT 3`).bind(seconds,seconds).all<Job>();
  if(!pending.success)throw Error('Report queue unavailable');
  for(const job of pending.results)if(await processReportJob(db,job,now,{...options,rss}))processed++;
  // Exhausted abandoned leases are terminal, never an unbounded retry queue.
  const abandoned=await db.prepare("SELECT job_key FROM life_report_jobs WHERE attempts>=3 AND ((state='generating' AND lease_until<=?) OR state='queued') LIMIT 3").bind(seconds).all<{job_key:string}>();
  if(!abandoned.success)throw Error('Report lease read unavailable');
  if(abandoned.results.length&&await reserveReportWrite(db)){
    const result=await db.batch(abandoned.results.map(row=>db.prepare("UPDATE life_report_jobs SET state='failed',error_code='generation-unavailable',lease_token=NULL,lease_until=NULL,updated_at=? WHERE job_key=? AND attempts>=3 AND ((state='generating' AND lease_until<=?) OR state='queued')").bind(seconds,row.job_key,seconds)));
    if(result.some(row=>!row.success))throw Error('Report lease cleanup unconfirmed');
  }
  return {owners:preferences.length,queued,processed};
}
