import type {D1Database} from '@cloudflare/workers-types';
import type {Env} from '../db/db';
import type {MailVault} from './report-mail-contacts';
import {submitReportDelivery,type ReportMailProvider} from './report-mail-delivery';
import {prepareReportMail} from './report-mail-prepare';
import {reportMailConfiguration} from './report-mail-config';
import {reserveReportWrite} from './report-settings';
import {REPORT_AI_PRICE_REVIEW_BEFORE} from './report-ai';
import type {CheckinVault} from './checkin-vault';
import {optionalCheckinVault} from './checkin-key-guard';

/** No reclaimable generation lease wraps this external side effect. Every send
 * has its own irrevocable claim, fixed message and retained admission receipt.
 * Rotate at most three candidates to avoid one damaged snapshot starving peers. */
export async function runReportMailSchedule(options:{db:D1Database;vault:MailVault;checkinVault?:CheckinVault|null;provider:ReportMailProvider;awaitAutomaticAnalysis?:boolean;now?:Date}){
  const {db,vault,provider}=options,now=options.now??new Date(),seconds=Math.floor(now.getTime()/1000),started=Date.now();
  if(!Number.isSafeInteger(seconds)||seconds<0)throw Error('Invalid mail schedule time');
  const previous=await db.prepare('SELECT after_anchor,after_key FROM life_report_mail_scheduler_state WHERE id=1').all<{after_anchor:number;after_key:string}>();
  if(!previous.success)throw Error('Mail scheduler unavailable');const cursor=previous.results[0];
  const select=async(anchor:number,key:string)=>{
    const rows=await db.prepare(`SELECT j.owner_id,j.job_key,j.anchor_at FROM life_report_jobs j
      JOIN users u ON u.id=j.owner_id AND u.permission=1 AND (u.access_expires_at IS NULL OR u.access_expires_at>?)
      JOIN life_report_preferences p ON p.owner_id=j.owner_id AND p.email_enabled=1
      JOIN life_report_mail_contacts c ON c.owner_id=j.owner_id AND c.verified_at IS NOT NULL AND c.paused_reason IS NULL AND c.enabled_at IS NOT NULL AND c.enabled_at<=j.anchor_at
      LEFT JOIN life_report_mail_deliveries d ON d.owner_id=j.owner_id AND d.kind='report' AND d.purpose_key=j.job_key
      WHERE j.state='ready' AND j.anchor_at>=? AND j.anchor_at<=? AND (j.anchor_at>? OR (j.anchor_at=? AND j.job_key>?))
      AND ((j.kind='daily' AND p.daily_enabled=1) OR (j.kind='weekly' AND p.weekly_enabled=1)) AND (j.include_daily=0 OR p.daily_enabled=1)
      AND (d.delivery_key IS NULL OR d.state='queued') ORDER BY j.anchor_at,j.job_key LIMIT 3`).bind(seconds,seconds-86400,seconds,anchor,anchor,key).all<{owner_id:number;job_key:string;anchor_at:number}>();
    if(!rows.success)throw Error('Mail queue unavailable');return rows.results;
  };
  let jobs=await select(cursor?.after_anchor??0,cursor?.after_key??'');
  if(!jobs.length&&cursor)jobs=await select(0,'');
  let processed=0,failures=0;
  for(const job of jobs){
    if(Date.now()-started>=28000)break;
    try{
      const prepared=await prepareReportMail({db,ownerId:job.owner_id,jobKey:job.job_key,providerIdentity:provider.identity,checkinVault:options.checkinVault,includeAnalysis:true,awaitAutomaticAnalysis:options.awaitAutomaticAnalysis,now});
      if('key' in prepared&&prepared.state==='queued')await submitReportDelivery({db,ownerId:job.owner_id,key:prepared.key,vault,checkinVault:options.checkinVault,provider,now,timeoutMs:Math.max(1,Math.min(15000,30000-(Date.now()-started)))});
    }catch{failures++;} // Never log a private message/recipient or reset a claim.
    processed++;
  }
  const last=jobs[processed-1];
  if(last&&(last.anchor_at!==cursor?.after_anchor||last.job_key!==cursor?.after_key)&&await reserveReportWrite(db)){
    const stored=await db.prepare(`INSERT INTO life_report_mail_scheduler_state(id,after_anchor,after_key) VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET after_anchor=excluded.after_anchor,after_key=excluded.after_key WHERE after_anchor=? AND after_key=?`).bind(last.anchor_at,last.job_key,cursor?.after_anchor??0,cursor?.after_key??'').all();
    if(!stored.success)throw Error('Mail cursor save unconfirmed');
  }
  return {processed,failures};
}

export async function runConfiguredReportMail(env:Env){
  if(env.REPORT_OUTBOUND_PAUSED==='true'||env.REPORT_MAIL_ENABLED!=='true')return {processed:0,failures:0};
  const config=await reportMailConfiguration(env);
  if(!config.vault||!config.provider)return {processed:0,failures:0};
  return runReportMailSchedule({db:env.DB,vault:config.vault,checkinVault:await optionalCheckinVault(env),provider:config.provider,awaitAutomaticAnalysis:Boolean(env.DEEPSEEK_API_KEY?.trim())&&Date.now()<REPORT_AI_PRICE_REVIEW_BEFORE});
}
