import type {D1Database} from '@cloudflare/workers-types';
import type {CheckinVault} from './checkin-vault';
import {decodeReportRow} from './report-history';
import {generateCheckinAnalysis} from './checkin-analysis';
import {REPORT_AI_PRICE_REVIEW_BEFORE} from './report-ai';
import {reportWindow} from './life-report';
import {reserveReportWrite} from './report-settings';
/** One primary report/tick, including before its send time after capture. No
 * daily appendix extra charge, reclaimable external lease, or catch-up consent. */
export async function runSelectedAISchedule(options:{db:D1Database;vault:CheckinVault;apiKey?:string;now?:Date;fetcher?:(url:string,init:RequestInit)=>Promise<Response>}){
 const {db}=options,now=options.now??new Date(),at=Math.floor(now.getTime()/1000);
 if(!options.apiKey?.trim()||!Number.isSafeInteger(at)||at<0||now.getTime()>=REPORT_AI_PRICE_REVIEW_BEFORE)return {processed:0,failures:0};
 const prior=await db.prepare('SELECT after_anchor,after_key FROM life_report_selected_ai_scheduler_state WHERE id=1').all<{after_anchor:number;after_key:string}>();
 if(!prior.success)throw Error('Selected AI cursor unavailable');const cursor=prior.results[0];
 const select=async(anchor:number,key:string)=>{
  const rows=await db.prepare(`SELECT j.job_key,j.owner_id,j.report_id,j.kind,j.anchor_at,j.period_start,j.period_end,c.enabled_at,c.revision
   FROM life_report_jobs j JOIN users u ON u.id=j.owner_id AND u.permission=1 AND (u.access_expires_at IS NULL OR u.access_expires_at>?)
   JOIN life_report_preferences p ON p.owner_id=j.owner_id
   JOIN life_report_selected_ai_consent c ON c.owner_id=j.owner_id AND c.scope_version=2 AND c.enabled_at IS NOT NULL AND c.enabled_at<=j.anchor_at
   JOIN life_report_checkin_snapshots x ON x.report_id=j.report_id AND x.owner_id=j.owner_id AND x.outbound_eligible=1 AND x.created_at>=c.enabled_at AND x.created_at<=?
   LEFT JOIN life_report_checkin_analyses a ON a.report_id=j.report_id AND a.owner_id=j.owner_id
   WHERE j.state='ready' AND a.request_key IS NULL AND j.anchor_at>=? AND j.anchor_at<=?
    AND (j.anchor_at>? OR (j.anchor_at=? AND j.job_key>?))
    AND NOT EXISTS(SELECT 1 FROM life_report_analyses n WHERE n.owner_id=j.owner_id AND n.report_id=j.report_id)
    AND ((j.kind='daily' AND p.daily_enabled=1) OR (j.kind='weekly' AND p.weekly_enabled=1)) AND (j.include_daily=0 OR p.daily_enabled=1)
   ORDER BY j.anchor_at,j.job_key LIMIT 1`).bind(at,at,at-86400,at+86400,anchor,anchor,key).all<{job_key:string;owner_id:number;report_id:number;kind:'daily'|'weekly';anchor_at:number;period_start:number;period_end:number;enabled_at:number;revision:number}>();
  if(!rows.success)throw Error('Selected AI queue unavailable');return rows.results[0];
 };
 let job=await select(cursor?.after_anchor??0,cursor?.after_key??'');if(!job&&cursor)job=await select(0,'');
 if(!job)return {processed:0,failures:0};let failures=0;
 try{
  const rows=await db.prepare('SELECT id,kind,period_start,period_end,snapshot_json,snapshot_sha256 FROM life_reports WHERE id=? AND owner_id=?').bind(job.report_id,job.owner_id).all<Record<string,unknown>>();
  if(!rows.success||!rows.results[0])throw Error('Selected AI report unavailable');const saved=await decodeReportRow(job.owner_id,rows.results[0]),expected=reportWindow(job.kind,new Date(job.anchor_at*1000));
  if(saved.report.period.kind!==job.kind||saved.report.period.start!==expected.start||saved.report.period.end!==expected.end||job.period_start*1000!==Date.parse(expected.start)||job.period_end*1000!==Date.parse(expected.end))throw Error('Selected AI occurrence mismatch');
  await generateCheckinAnalysis({...options,owner:job.owner_id,saved,enabled:true,scope2Approved:true,scheduled:{jobKey:job.job_key,consentedAt:job.enabled_at,revision:job.revision}});
 }catch{failures++;} // No raw provider/body/identity diagnostics.
 if((job.anchor_at!==cursor?.after_anchor||job.job_key!==cursor?.after_key)&&await reserveReportWrite(db)){
  const result=await db.prepare(`INSERT INTO life_report_selected_ai_scheduler_state(id,after_anchor,after_key) VALUES(1,?,?)
   ON CONFLICT(id) DO UPDATE SET after_anchor=excluded.after_anchor,after_key=excluded.after_key WHERE after_anchor=? AND after_key=?`).bind(job.anchor_at,job.job_key,cursor?.after_anchor??0,cursor?.after_key??'').all();
  if(!result.success)throw Error('Selected AI cursor save unconfirmed');
 }
 return {processed:1,failures};
}
