import type {D1Database} from '@cloudflare/workers-types';
import type {CheckinVault} from './checkin-vault';
import type {LifeReportPreview} from './life-report';
import {checkinKeyGuard} from './checkin-key-guard';
import {readReportBrief} from './report-brief-snapshot';
import {readReportCheckins,checkinSourceGuard} from './report-checkin-snapshot';
import {briefMailContent} from './report-brief-mail';
import {reportMailMessage,type MailAdmissionGuard} from './report-mail-delivery';
import {reportDigest} from './report-analysis-format';
import {readRssCapture} from './rss-daily-cycle';
type Saved={id:number;sha256:string;report:LifeReportPreview};
export const PRIVATE_MAIL_MARKER='{"version":2,"private":true}';
type Binding={version:1;reportId:number;reportSha:string;briefHmac:string;checkinHmac:string;consentRevision:number;enabledAt:number;anchor:number};

function privateGuard(owner:number,vault:CheckinVault,b:Binding,source:MailAdmissionGuard):MailAdmissionGuard{
 return {sql:`(${source.sql})
  AND EXISTS(SELECT 1 FROM life_checkin_key_guard WHERE id=1 AND fingerprint=?)
  AND EXISTS(SELECT 1 FROM life_report_brief_consent WHERE owner_id=? AND scope_version=3 AND revision=? AND enabled_at=? AND enabled_at<=?)
  AND EXISTS(SELECT 1 FROM life_reports r JOIN life_report_briefs b ON b.report_id=r.id AND b.owner_id=r.owner_id
    JOIN life_report_checkin_snapshots x ON x.report_id=r.id AND x.owner_id=r.owner_id
    WHERE r.id=? AND r.owner_id=? AND r.snapshot_sha256=? AND b.report_sha256=r.snapshot_sha256 AND b.outbound_eligible=1
      AND b.content_hmac=? AND b.checkin_hmac=? AND b.scheduled_at=? AND x.content_hmac=b.checkin_hmac AND x.outbound_eligible=1
      AND b.created_at>=?)`,args:[...source.args,vault.keyFingerprint,owner,b.consentRevision,b.enabledAt,b.anchor,b.reportId,owner,b.reportSha,b.briefHmac,b.checkinHmac,b.anchor,b.enabledAt]};
}

/** New consent must predate capture. A numeric consent is never an upgrade. */
export async function preparePrivateReportMail(db:D1Database,vault:CheckinVault,owner:number,key:string,saved:Saved,anchor:number){
 const consent=await db.prepare('SELECT revision,enabled_at FROM life_report_brief_consent WHERE owner_id=? AND scope_version=3 AND enabled_at IS NOT NULL AND enabled_at<=?').bind(owner,Math.min(anchor,Math.floor(Date.parse(saved.report.generatedAt)/1000))).all<{revision:number;enabled_at:number}>();
 if(!consent.success)throw Error('Brief consent unavailable');if(!consent.results[0])return null;
 await checkinKeyGuard(db,vault);
 const brief=await readReportBrief(db,vault,owner,saved),selected=await readReportCheckins(db,vault,owner,saved);
 if(!brief?.outboundEligible||brief.context.scheduledFor.getTime()/1000!==anchor||!selected?.current||!('sources' in selected.snapshot))return null;
 const b:Binding={version:1,reportId:saved.id,reportSha:saved.sha256,briefHmac:brief.contentHmac,checkinHmac:brief.checkinHmac,consentRevision:consent.results[0].revision,enabledAt:consent.results[0].enabled_at,anchor};
 const message=reportMailMessage(briefMailContent({context:brief.context,facts:brief.facts,report:saved.report,rss:brief.rss??undefined,rssRefresh:await readRssCapture(db,owner,saved.id,saved.sha256),checkins:selected.snapshot}));
 const payload={binding:b,message},sealed=await vault.sealPayload(owner,'report-mail',key,payload),hmac=await vault.payloadDigest(owner,'report-mail',key,payload);
 const source=checkinSourceGuard(owner,selected.snapshot.rangeFrom,selected.snapshot.toDateExclusive,selected.snapshot.sources);
 return {message,digest:await reportDigest(JSON.stringify(message)),sealed,hmac,reportId:saved.id,guard:privateGuard(owner,vault,b,source)};
}

/** Decrypt only in memory and re-derive live guards. No archive can supply proofs. */
export async function openPrivateReportMail(db:D1Database,vault:CheckinVault,owner:number,key:string,jobKey:string){
 await checkinKeyGuard(db,vault);
 const rows=await db.prepare('SELECT report_id,sealed_json,content_hmac FROM life_report_private_messages WHERE owner_id=? AND delivery_key=?').bind(owner,key).all<{report_id:number;sealed_json:string;content_hmac:string}>();
 if(!rows.success||rows.results.length!==1)throw Error('Private mail unavailable');const row=rows.results[0];
 const payload=await vault.openPayload(owner,'report-mail',key,row.sealed_json) as {binding:Binding;message:unknown};
 if(await vault.payloadDigest(owner,'report-mail',key,payload)!==row.content_hmac)throw Error('Private mail authentication failed');
 const b=payload.binding;
 if(!b||b.version!==1||b.reportId!==row.report_id||!Number.isSafeInteger(b.consentRevision)||b.consentRevision<1||!Number.isSafeInteger(b.enabledAt)||!Number.isSafeInteger(b.anchor))throw Error('Private mail binding unavailable');
 const jobs=await db.prepare('SELECT report_id,anchor_at FROM life_report_jobs WHERE owner_id=? AND job_key=?').bind(owner,jobKey).all<{report_id:number;anchor_at:number}>();
 if(!jobs.success||jobs.results[0]?.report_id!==b.reportId||jobs.results[0].anchor_at!==b.anchor)throw Error('Private mail occurrence mismatch');
 // Re-read the authenticated snapshot, never render a replacement message.
 const parents=await db.prepare('SELECT snapshot_json,snapshot_sha256 FROM life_reports WHERE owner_id=? AND id=?').bind(owner,b.reportId).all<{snapshot_json:string;snapshot_sha256:string}>();
 if(!parents.success||parents.results[0]?.snapshot_sha256!==b.reportSha)throw Error('Private mail parent unavailable');
 const saved={id:b.reportId,sha256:b.reportSha,report:JSON.parse(parents.results[0].snapshot_json) as LifeReportPreview};
 if(await reportDigest(JSON.stringify(saved.report))!==b.reportSha)throw Error('Private mail parent authentication failed');
 const brief=await readReportBrief(db,vault,owner,saved),selected=await readReportCheckins(db,vault,owner,saved);
 if(!brief?.outboundEligible||brief.contentHmac!==b.briefHmac||brief.checkinHmac!==b.checkinHmac||!selected?.current||!('sources' in selected.snapshot))throw Error('Private mail scope changed');
 const source=checkinSourceGuard(owner,selected.snapshot.rangeFrom,selected.snapshot.toDateExclusive,selected.snapshot.sources);
 return {message:reportMailMessage(payload.message),guard:privateGuard(owner,vault,b,source)};
}
