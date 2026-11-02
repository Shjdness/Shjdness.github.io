import type {D1Database} from '@cloudflare/workers-types';
import type {Env} from '../db/db';
import {REPORT_AI_PRICE_REVIEW_BEFORE} from './report-ai';
import {REPORT_AI_MODEL} from './report-analysis-format';
import {decodeReportRow} from './report-history';
import {generateReportAnalysis} from './report-analysis';
import {reserveReportWrite} from './report-settings';
import {reportWindow} from './life-report';

/** At most one primary analysis per tick; a weekly email's daily appendix is
 * statistics only. Manual and scheduled calls share the same immutable result,
 * monthly cap and non-reclaimable claim. Missing/expired config never calls AI. */
export async function runReportAISchedule(options:{db:D1Database;apiKey?:string;now?:Date;fetcher?:(url:string,init:RequestInit)=>Promise<Response>}){
  const {db}=options,now=options.now??new Date(),seconds=Math.floor(now.getTime()/1000);
  if(!options.apiKey?.trim()||!Number.isSafeInteger(seconds)||seconds<0||now.getTime()>=REPORT_AI_PRICE_REVIEW_BEFORE)return {processed:0,failures:0};
  const prior=await db.prepare('SELECT after_anchor,after_key FROM life_report_ai_scheduler_state WHERE id=1').all<{after_anchor:number;after_key:string}>();
  if(!prior.success)throw Error('AI schedule unavailable');const cursor=prior.results[0];
  const select=async(anchor:number,key:string)=>{
    const rows=await db.prepare(`SELECT j.job_key,j.owner_id,j.report_id,j.anchor_at,j.kind,j.period_start,j.period_end,c.enabled_at FROM life_report_jobs j
      JOIN users u ON u.id=j.owner_id AND u.permission=1 AND (u.access_expires_at IS NULL OR u.access_expires_at>?)
      JOIN life_report_preferences p ON p.owner_id=j.owner_id AND p.ai_enabled=1
      JOIN life_report_ai_consent c ON c.owner_id=j.owner_id AND c.enabled_at IS NOT NULL AND c.scope_version=1 AND c.enabled_at<=j.anchor_at
      LEFT JOIN life_report_analyses a ON a.owner_id=j.owner_id AND a.report_id=j.report_id AND a.model=? AND a.prompt_version=1
      WHERE j.state='ready' AND a.request_key IS NULL AND j.anchor_at>=? AND j.anchor_at<=? AND (j.anchor_at>? OR (j.anchor_at=? AND j.job_key>?))
      AND NOT EXISTS(SELECT 1 FROM life_report_checkin_snapshots x WHERE x.owner_id=j.owner_id AND x.report_id=j.report_id)
      AND ((j.kind='daily' AND p.daily_enabled=1) OR (j.kind='weekly' AND p.weekly_enabled=1)) AND (j.include_daily=0 OR p.daily_enabled=1)
      ORDER BY j.anchor_at,j.job_key LIMIT 1`).bind(seconds,REPORT_AI_MODEL,seconds-86400,seconds,anchor,anchor,key).all<{job_key:string;owner_id:number;report_id:number;anchor_at:number;kind:'daily'|'weekly';period_start:number;period_end:number;enabled_at:number}>();
    if(!rows.success)throw Error('AI queue unavailable');return rows.results[0];
  };
  let job=await select(cursor?.after_anchor??0,cursor?.after_key??'');if(!job&&cursor)job=await select(0,'');
  if(!job)return {processed:0,failures:0};let failures=0;
  try{
    const rows=await db.prepare('SELECT id,kind,period_start,period_end,snapshot_json,snapshot_sha256 FROM life_reports WHERE owner_id=? AND id=?').bind(job.owner_id,job.report_id).all<Record<string,unknown>>();
    if(!rows.success||!rows.results[0])throw Error('AI snapshot unavailable');
    const saved=await decodeReportRow(job.owner_id,rows.results[0]);
    const expected=reportWindow(job.kind,new Date(job.anchor_at*1000));
    if(saved.report.period.kind!==job.kind||saved.report.period.start!==expected.start||saved.report.period.end!==expected.end||job.period_start*1000!==Date.parse(expected.start)||job.period_end*1000!==Date.parse(expected.end))throw Error('AI job snapshot mismatch');
    await generateReportAnalysis({db,ownerId:job.owner_id,saved,enabled:true,apiKey:options.apiKey,fetcher:options.fetcher,now,scheduled:{jobKey:job.job_key,consentedAt:job.enabled_at}});
  }catch{failures++;}
  if((job.anchor_at!==cursor?.after_anchor||job.job_key!==cursor?.after_key)&&await reserveReportWrite(db)){
    const saved=await db.prepare(`INSERT INTO life_report_ai_scheduler_state(id,after_anchor,after_key) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET after_anchor=excluded.after_anchor,after_key=excluded.after_key WHERE after_anchor=? AND after_key=?`).bind(job.anchor_at,job.job_key,cursor?.after_anchor??0,cursor?.after_key??'').all();
    if(!saved.success)throw Error('AI cursor save unconfirmed');
  }
  return {processed:1,failures};
}
export const runConfiguredReportAI=(env:Env)=>env.REPORT_OUTBOUND_PAUSED==='true'?Promise.resolve({processed:0,failures:0}):runReportAISchedule({db:env.DB,apiKey:env.DEEPSEEK_API_KEY});
