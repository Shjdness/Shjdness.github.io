import type {D1Database} from '@cloudflare/workers-types';
import {reportDigest} from './report-analysis-format';
import {readMailContact,reportMailOwner,type MailVault} from './report-mail-contacts';
import {reportVerificationToken} from './report-mail-vault';
import {reserveReportWrite} from './report-settings';

export type ReportMailMessage={subject:string;text:string;html:string};
export type ReportMailProvider={identity:string;submit:(message:ReportMailMessage&{to:string;deliveryKey:string},signal:AbortSignal)=>Promise<{state:'accepted';id:string}|{state:'rejected'}|{state:'unknown'}>};
type Delivery={delivery_key:string;owner_id:number;kind:'verification'|'report';contact_revision:number;fingerprint:string;provider_identity:string;provider_id:string|null;state:string;message_json:string|null;message_sha256:string;created_at:number;updated_at:number};

export function reportMailMessage(value:unknown):ReportMailMessage{
  const v=value as ReportMailMessage;
  if(!v||typeof v.subject!=='string'||!v.subject.trim()||v.subject.length>200||/[\r\n\u0000]/.test(v.subject)||typeof v.text!=='string'||typeof v.html!=='string'||JSON.stringify(v).length>16384)throw Error('Invalid report mail message');
  return {subject:v.subject,text:v.text,html:v.html};
}

export async function readReportDelivery(db:D1Database,ownerId:number,key:string,now=new Date()){
  const rows=await db.prepare('SELECT delivery_key,kind,state,provider_id,error_code,created_at,updated_at FROM life_report_mail_deliveries WHERE owner_id=? AND delivery_key=?').bind(ownerId,key).all<Record<string,unknown>>();
  if(!rows.success)throw Error('Delivery read unavailable');const row=rows.results[0];
  if(!row)return null;
  return {state:row.state==='submitting'&&now.getTime()/1000-Number(row.updated_at)>=60?'unknown':String(row.state),providerAccepted:Boolean(row.provider_id),errorCode:row.error_code??null};
}

/** UTC infrastructure quota: site<=100 accepted submissions/day, verification
 * <=3 and reports<=2 per owner/day. Unknown calls retain durable reservations. */
export async function reserveMailSubmission(db:D1Database,ownerId:number,key:string,kind:'verification'|'report',now=new Date()){
  const day=now.toISOString().slice(0,10),own=`mail:${day}:${ownerId}:${kind}`,global=`mail:${day}:site`,cap=kind==='verification'?3:2;
  const old=await db.prepare('SELECT request_key FROM life_report_mail_admissions WHERE request_key=?').bind(key).all();
  if(!old.success)throw Error('Mail quota read unavailable');if(old.results.length)return 'existing' as const;
  const result=await db.batch([
    db.prepare('INSERT INTO life_report_mail_budget(bucket,reserved) VALUES(?,0) ON CONFLICT DO NOTHING').bind(own),
    db.prepare('INSERT INTO life_report_mail_budget(bucket,reserved) VALUES(?,0) ON CONFLICT DO NOTHING').bind(global),
    db.prepare(`INSERT INTO life_report_mail_admissions(request_key,owner_bucket,global_bucket,created_at)
      SELECT ?,a.bucket,b.bucket,? FROM life_report_mail_budget a,life_report_mail_budget b WHERE a.bucket=? AND b.bucket=? AND a.reserved<? AND b.reserved<100
      ON CONFLICT(request_key) DO NOTHING RETURNING request_key`).bind(key,Math.floor(now.getTime()/1000),own,global,cap),
    db.prepare('UPDATE life_report_mail_budget SET reserved=reserved+1 WHERE bucket=? AND changes()>0').bind(own),
    db.prepare('UPDATE life_report_mail_budget SET reserved=reserved+1 WHERE bucket=? AND changes()>0').bind(global),
  ]);
  if(result.some(row=>!row.success))throw Error('Mail quota unconfirmed');
  if(result[2].results.length===1)return 'admitted' as const;
  const existing=await db.prepare('SELECT request_key FROM life_report_mail_admissions WHERE request_key=?').bind(key).all();
  if(!existing.success)throw Error('Mail quota read unavailable');return existing.results.length?'existing' as const:'budget' as const;
}

/** Deliberately no lease takeover or automatic resend. A response lost after
 * acceptance leaves submitting/unknown until a verified callback/reconciliation. */
export async function submitReportDelivery(options:{db:D1Database;ownerId:number;key:string;vault:MailVault;provider:ReportMailProvider;verificationMessage?:ReportMailMessage;now?:Date;timeoutMs?:number}){
  const {db,ownerId,provider,vault,key}=options,now=options.now??new Date(),seconds=Math.floor(now.getTime()/1000);
  if(!await reportMailOwner(db,ownerId,seconds))throw Error('Owner access required');
  const rows=await db.prepare('SELECT * FROM life_report_mail_deliveries WHERE owner_id=? AND delivery_key=?').bind(ownerId,key).all<Delivery>();
  if(!rows.success)throw Error('Delivery read unavailable');const row=rows.results[0];if(!row)return null;
  if(row.state!=='queued')return readReportDelivery(db,ownerId,key,now);
  const stop=async(reason:string)=>{const result=await db.prepare("UPDATE life_report_mail_deliveries SET state='paused',error_code=?,updated_at=? WHERE owner_id=? AND delivery_key=? AND state='queued'").bind(reason,seconds,ownerId,key).all();if(!result.success)throw Error('Delivery pause unconfirmed');return readReportDelivery(db,ownerId,key,now);};
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(provider.identity)||row.provider_identity!==provider.identity)return stop('configuration-changed');
  const contact=await readMailContact(db,ownerId);
  if(!contact||contact.fingerprint!==row.fingerprint||contact.revision!==row.contact_revision||contact.paused_reason)return stop('recipient-changed');
  let to:string,message:ReportMailMessage;
  try{
    to=await vault.open(ownerId,contact.email_sealed);
    if(await vault.fingerprint(ownerId,to)!==row.fingerprint)throw Error();
    message=reportMailMessage(row.kind==='verification'?options.verificationMessage:JSON.parse(row.message_json??'null'));
    if(await reportDigest(JSON.stringify(message))!==row.message_sha256)throw Error();
  }catch{return stop('configuration-changed');}
  if(!await reserveReportWrite(db))return {state:'queued',providerAccepted:false,errorCode:'write-budget'};
  const claimSeconds=Math.max(seconds,Math.floor(Date.now()/1000));
  const claim=await db.prepare(`UPDATE life_report_mail_deliveries SET state='submitting',updated_at=? WHERE owner_id=? AND delivery_key=? AND state='queued'
    AND EXISTS(SELECT 1 FROM users WHERE id=? AND permission=1 AND (access_expires_at IS NULL OR access_expires_at>?))
    AND EXISTS(SELECT 1 FROM life_report_mail_contacts c WHERE c.owner_id=? AND c.revision=? AND c.fingerprint=? AND c.paused_reason IS NULL
      AND (?='verification' OR (c.verified_at IS NOT NULL AND EXISTS(SELECT 1 FROM life_report_preferences p WHERE p.owner_id=c.owner_id AND p.email_enabled=1))))
    AND (?='verification' OR EXISTS(SELECT 1 FROM life_report_jobs j JOIN life_report_preferences p ON p.owner_id=j.owner_id
      WHERE j.job_key=life_report_mail_deliveries.job_key AND j.owner_id=? AND j.state='ready' AND j.anchor_at>=(SELECT enabled_at FROM life_report_mail_contacts WHERE owner_id=j.owner_id) AND j.anchor_at>=? AND j.anchor_at<=? AND ((j.kind='daily' AND p.daily_enabled=1) OR (j.kind='weekly' AND p.weekly_enabled=1)) AND (j.include_daily=0 OR p.daily_enabled=1)))
    RETURNING delivery_key`).bind(claimSeconds,ownerId,key,ownerId,claimSeconds,ownerId,row.contact_revision,row.fingerprint,row.kind,row.kind,ownerId,claimSeconds-86400,claimSeconds).all();
  if(!claim.success)throw Error('Mail claim unconfirmed');if(!claim.results.length)return stop('disabled');
  let outcome:{state:'accepted';id:string}|{state:'rejected'}|{state:'unknown'}={state:'unknown'};
  try{
    const admission=await reserveMailSubmission(db,ownerId,key,row.kind,now);
    if(admission!=='admitted')outcome={state:admission==='existing'?'unknown':'rejected'};
    else{
      const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
      const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Mail deadline'));},Math.max(1,Math.min(options.timeoutMs??15000,15000)));});
      try{outcome=await Promise.race([provider.submit({...message,to,deliveryKey:key},controller.signal),deadline]);}
      finally{clearTimeout(timer!);controller.abort();}
      if(!outcome||!['accepted','rejected','unknown'].includes(outcome.state))outcome={state:'unknown'};
      if(outcome.state==='accepted'&&(typeof outcome.id!=='string'||!outcome.id.length||outcome.id.length>256||/[\u0000-\u0020\u007f]/.test(outcome.id)))outcome={state:'unknown'};
    }
  }catch{outcome={state:'unknown'};}
  const result=await db.prepare(`UPDATE life_report_mail_deliveries SET state=?,provider_id=?,error_code=?,updated_at=?
    WHERE owner_id=? AND delivery_key=? AND state='submitting' RETURNING delivery_key`).bind(outcome.state,outcome.state==='accepted'?outcome.id:null,outcome.state==='accepted'?null:outcome.state==='rejected'?'rejected':'unavailable',Math.max(claimSeconds,Math.floor(Date.now()/1000)),ownerId,key).all();
  if(!result.success)throw Error('Mail outcome save unconfirmed');
  return readReportDelivery(db,ownerId,key,now);
}

/** Internal injected-provider flow only. The inbox token exists only in memory
 * and the outbound message, never in the database, HTTP response or a log. */
export async function requestReportVerification(options:{db:D1Database;ownerId:number;vault:MailVault;provider?:ReportMailProvider;now?:Date;timeoutMs?:number}){
  const {db,ownerId,provider}=options,now=options.now??new Date(),seconds=Math.floor(now.getTime()/1000);
  if(!provider||!/^[A-Za-z0-9_-]{1,64}$/.test(provider.identity))return {state:'not-configured'};
  if(!await reportMailOwner(db,ownerId,seconds))throw Error('Owner access required');
  const contact=await readMailContact(db,ownerId);if(!contact||contact.paused_reason)return {state:'verification-required'};
  if(contact.verified_at!==null)return {state:'already-verified'};
  const slots=await db.prepare('SELECT contact_revision,delivery_key,expires_at FROM life_report_mail_verification_slots WHERE owner_id=?').bind(ownerId).all<{contact_revision:number;delivery_key:string;expires_at:number}>();
  if(!slots.success)throw Error('Verification read unavailable');
  const previous=slots.results[0];
  if(previous&&previous.contact_revision===contact.revision&&previous.expires_at>seconds)return await readReportDelivery(db,ownerId,previous.delivery_key,now)??{state:'unknown'};
  if(!await reserveReportWrite(db))return {state:'write-budget'};
  const token=await reportVerificationToken(),key=await reportDigest(`report-mail-verification:v1:${ownerId}:${token.hash}`);
  const claim=await db.prepare(`INSERT INTO life_report_mail_verification_slots(owner_id,contact_revision,delivery_key,expires_at)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM life_report_mail_contacts WHERE owner_id=? AND revision=? AND fingerprint=? AND paused_reason IS NULL)
    ON CONFLICT(owner_id) DO UPDATE SET contact_revision=excluded.contact_revision,delivery_key=excluded.delivery_key,expires_at=excluded.expires_at
      WHERE expires_at<=? OR contact_revision<>excluded.contact_revision RETURNING delivery_key`).bind(ownerId,contact.revision,key,seconds+1800,ownerId,contact.revision,contact.fingerprint,seconds).all();
  if(!claim.success)throw Error('Verification claim unconfirmed');if(!claim.results.length)return {state:'pending'};
  const link=`https://shjdness.github.io/life/reports#verify=${token.token}`;
  const message:ReportMailMessage={subject:'夏令时电波 · 验证提醒邮箱',text:`你请求验证生活报告的收件邮箱。链接30分钟有效，需登录自己的账号。\n${link}\n验证成功也不会自动开启投递；若非本人请求，可忽略此邮件。`,html:`<p>你请求验证生活报告的收件邮箱。链接30分钟有效，需登录自己的账号。</p><p><a href="${link}">验证提醒邮箱</a></p><p>验证成功也不会自动开启投递；若非本人请求，可忽略此邮件。</p>`};
  const result=await db.batch([
    db.prepare(`INSERT INTO life_report_mail_deliveries(delivery_key,owner_id,kind,purpose_key,contact_revision,fingerprint,provider_identity,state,message_sha256,created_at,updated_at)
      VALUES(?,?,'verification',?,?,?,?,'queued',?,?,?)`).bind(key,ownerId,token.hash,contact.revision,contact.fingerprint,provider.identity,await reportDigest(JSON.stringify(message)),seconds,seconds),
    db.prepare(`INSERT INTO life_report_mail_verifications(token_hash,owner_id,contact_revision,fingerprint,delivery_key,created_at,expires_at) VALUES(?,?,?,?,?,?,?)`).bind(token.hash,ownerId,contact.revision,contact.fingerprint,key,seconds,seconds+1800),
  ]);
  if(result.some(row=>!row.success))throw Error('Verification queue unconfirmed');
  return submitReportDelivery({...options,provider,key,verificationMessage:message});
}
