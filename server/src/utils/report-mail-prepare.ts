import type {D1Database} from '@cloudflare/workers-types';
import {reportDigest} from './report-analysis-format';
import {readMailContact,reportMailOwner} from './report-mail-contacts';
import {decodeReportRow} from './report-history';
import {readReportAnalysis} from './report-analysis';
import {reportMailContent} from './report-mail-format';
import {reportMailMessage,readReportDelivery} from './report-mail-delivery';
import {reserveReportWrite} from './report-settings';
import {reportWindow} from './life-report';

/** Freeze one report message per scheduled occurrence. Recipient changes or
 * retries never replace its original message, purpose, admission or outcome. */
export async function prepareReportMail(options:{db:D1Database;ownerId:number;jobKey:string;providerIdentity:string;includeAnalysis?:boolean;awaitAutomaticAnalysis?:boolean;now?:Date}){
  const {db,ownerId,jobKey,providerIdentity}=options,now=options.now??new Date(),seconds=Math.floor(now.getTime()/1000);
  if(!/^[a-f0-9]{64}$/.test(jobKey)||!/^[A-Za-z0-9_-]{1,64}$/.test(providerIdentity))throw Error('Invalid mail preparation');
  if(!await reportMailOwner(db,ownerId,seconds))throw Error('Owner access required');
  const key=await reportDigest(`report-mail:v1:${ownerId}:${jobKey}`);
  const existing=await readReportDelivery(db,ownerId,key,now);if(existing)return {key,...existing};
  const jobs=await db.prepare('SELECT kind,anchor_at,period_start,period_end,report_id,daily_report_id,include_daily FROM life_report_jobs WHERE owner_id=? AND job_key=? AND state=\'ready\'').bind(ownerId,jobKey).all<{kind:'daily'|'weekly';anchor_at:number;period_start:number;period_end:number;report_id:number;daily_report_id:number|null;include_daily:number}>();
  if(!jobs.success)throw Error('Mail job read unavailable');const job=jobs.results[0];if(!job)return {state:'not-ready'};
  const contact=await readMailContact(db,ownerId);
  if(!contact?.verified_at||contact.enabled_at===null||contact.paused_reason||job.anchor_at<contact.enabled_at)return {state:'disabled'};
  if(job.anchor_at<seconds-86400||job.anchor_at>seconds)return {state:'stale'};
  const flags=await db.prepare('SELECT email_enabled,daily_enabled,weekly_enabled,ai_enabled FROM life_report_preferences WHERE owner_id=?').bind(ownerId).all<{email_enabled:number;daily_enabled:number;weekly_enabled:number;ai_enabled:number}>();
  if(!flags.success)throw Error('Mail settings unavailable');const p=flags.results[0];
  if(!p||p.email_enabled!==1||(job.kind==='weekly'?p.weekly_enabled!==1:p.daily_enabled!==1)||(job.include_daily&&p.daily_enabled!==1))return {state:'disabled'};
  const load=async(id:number)=>{
    const rows=await db.prepare('SELECT id,kind,period_start,period_end,snapshot_json,snapshot_sha256 FROM life_reports WHERE id=? AND owner_id=?').bind(id,ownerId).all<Record<string,unknown>>();
    if(!rows.success||!rows.results[0])throw Error('Mail report missing');return decodeReportRow(ownerId,rows.results[0]);
  };
  const primary=await load(job.report_id),daily=job.include_daily?await load(job.daily_report_id!):null;
  const expected=reportWindow(job.kind,new Date(job.anchor_at*1000));
  if(primary.report.period.kind!==job.kind||primary.report.period.start!==expected.start||primary.report.period.end!==expected.end||job.period_start*1000!==Date.parse(expected.start)||job.period_end*1000!==Date.parse(expected.end))throw Error('Mail report binding mismatch');
  const analysis=options.includeAnalysis?await readReportAnalysis(db,ownerId,primary,now):null;
  if(analysis?.state==='pending')return {state:'analysis-pending'};
  // Give an opted-in automatic analysis two cron intervals to complete. Missing
  // config, terminal failures/unknown results or a longer delay use statistics.
  if(analysis?.state==='none'&&options.awaitAutomaticAnalysis&&p.ai_enabled===1&&seconds-job.anchor_at<600){
    const consent=await db.prepare('SELECT owner_id FROM life_report_ai_consent WHERE owner_id=? AND scope_version=1 AND enabled_at IS NOT NULL AND enabled_at<=?').bind(ownerId,job.anchor_at).all();
    if(!consent.success)throw Error('AI consent unavailable');if(consent.results.length)return {state:'analysis-pending'};
  }
  const message=reportMailMessage(reportMailContent({report:primary.report,daily:daily?.report,scheduledFor:new Date(job.anchor_at*1000).toISOString(),analysis:analysis?.state==='succeeded'?analysis.analysis??undefined:undefined}));
  const json=JSON.stringify(message),digest=await reportDigest(json);
  if(!await reserveReportWrite(db))return {state:'write-budget'};
  const result=await db.prepare(`INSERT INTO life_report_mail_deliveries(delivery_key,owner_id,kind,purpose_key,job_key,contact_revision,fingerprint,provider_identity,state,message_json,message_sha256,created_at,updated_at)
    SELECT ?,?,'report',?,?,?,?,?,'queued',?,?,?,? WHERE EXISTS(SELECT 1 FROM life_report_mail_contacts c JOIN life_report_preferences p ON p.owner_id=c.owner_id
      WHERE c.owner_id=? AND c.revision=? AND c.fingerprint=? AND c.verified_at IS NOT NULL AND c.enabled_at IS NOT NULL AND c.enabled_at<=? AND c.paused_reason IS NULL AND p.email_enabled=1)
    ON CONFLICT DO NOTHING RETURNING delivery_key`).bind(key,ownerId,jobKey,jobKey,contact.revision,contact.fingerprint,providerIdentity,json,digest,seconds,seconds,ownerId,contact.revision,contact.fingerprint,job.anchor_at).all();
  if(!result.success)throw Error('Mail preparation unconfirmed');
  const stored=await readReportDelivery(db,ownerId,key,now);
  return stored?{key,...stored}:{state:'disabled'};
}
