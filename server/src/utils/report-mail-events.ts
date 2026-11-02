import type {D1Database} from '@cloudflare/workers-types';
import {reportDigest} from './report-analysis-format';

export type ReportMailEvent={eventId:string;deliveryKey:string;providerId:string;providerIdentity:string;status:'accepted'|'delivered'|'rejected'|'bounced'|'complained'};
const rank:Record<string,number>={queued:0,submitting:0,unknown:0,accepted:1,delivered:2,rejected:3,bounced:4,complained:5};

/** Trusted normalized event only: a provider-specific authenticator MUST verify
 * the raw request before calling this function; never expose this function alone.
 * Event facts are monotone, not evidence that a person opened/read an email. */
export async function applyReportMailEvent(db:D1Database,event:ReportMailEvent,now=new Date()){
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(event.eventId)||!/^[a-f0-9]{64}$/.test(event.deliveryKey)||!/^[A-Za-z0-9_-]{1,64}$/.test(event.providerIdentity)||typeof event.providerId!=='string'||!event.providerId.length||event.providerId.length>256||/[\u0000-\u0020\u007f]/.test(event.providerId)||!['accepted','delivered','rejected','bounced','complained'].includes(event.status)||!Number.isFinite(now.getTime()))throw Error('Invalid mail event');
  const digest=await reportDigest(JSON.stringify([event.eventId,event.deliveryKey,event.providerId,event.providerIdentity,event.status]));
  const known=await db.prepare('SELECT event_sha256 FROM life_report_mail_events WHERE event_id=?').bind(event.eventId).all<{event_sha256:string}>();
  if(!known.success)throw Error('Mail event read unavailable');
  if(known.results[0])return {applied:false,duplicate:known.results[0].event_sha256===digest,conflict:known.results[0].event_sha256!==digest};
  const rows=await db.prepare(`SELECT d.owner_id,d.fingerprint,d.contact_revision,d.state,d.provider_id FROM life_report_mail_deliveries d
    JOIN life_report_mail_admissions a ON a.request_key=d.delivery_key WHERE d.delivery_key=? AND d.provider_identity=?`).bind(event.deliveryKey,event.providerIdentity).all<{owner_id:number;fingerprint:string;contact_revision:number;state:string;provider_id:string|null}>();
  if(!rows.success)throw Error('Mail event binding unavailable');const row=rows.results[0];
  if(!row||['queued','paused'].includes(row.state)||(row.provider_id!==null&&row.provider_id!==event.providerId))return {applied:false,ignored:true};
  if((rank[row.state]??99)>=rank[event.status])return {applied:false,unchanged:true};
  const seconds=Math.floor(now.getTime()/1000);
  const statements=[
    db.prepare(`INSERT INTO life_report_mail_events(event_id,delivery_key,status,event_sha256,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM life_report_mail_deliveries WHERE delivery_key=? AND provider_identity=? AND (provider_id IS NULL OR provider_id=?) AND state IN ('submitting','unknown','accepted','delivered','rejected','bounced') AND CASE state WHEN 'accepted' THEN 1 WHEN 'delivered' THEN 2 WHEN 'rejected' THEN 3 WHEN 'bounced' THEN 4 ELSE 0 END<?)
      ON CONFLICT(event_id) DO NOTHING RETURNING event_id`).bind(event.eventId,event.deliveryKey,event.status,digest,seconds,event.deliveryKey,event.providerIdentity,event.providerId,rank[event.status]),
    db.prepare(`UPDATE life_report_mail_deliveries SET state=?,provider_id=?,error_code=NULL,updated_at=?
      WHERE delivery_key=? AND provider_identity=? AND changes()>0 AND (provider_id IS NULL OR provider_id=?)
      AND state IN ('submitting','unknown','accepted','delivered','rejected','bounced')
      AND CASE state WHEN 'accepted' THEN 1 WHEN 'delivered' THEN 2 WHEN 'rejected' THEN 3 WHEN 'bounced' THEN 4 ELSE 0 END<? RETURNING delivery_key`).bind(event.status,event.providerId,seconds,event.deliveryKey,event.providerIdentity,event.providerId,rank[event.status]),
  ];
  if(event.status==='bounced'||event.status==='complained'){
    statements.push(
      db.prepare(`UPDATE life_report_mail_contacts SET paused_reason=?,enabled_at=NULL,updated_at=?
        WHERE owner_id=? AND fingerprint=? AND revision=? AND changes()>0 AND (paused_reason IS NULL OR paused_reason<> 'complained') RETURNING owner_id`).bind(event.status,seconds,row.owner_id,row.fingerprint,row.contact_revision),
      db.prepare('UPDATE life_report_preferences SET email_enabled=0,revision=revision+1,updated_at=? WHERE owner_id=? AND changes()>0').bind(seconds,row.owner_id),
    );
  }
  // A prior durable submission and a strictly increasing state bound useful
  // writes per message. Replays/no-op status events do not consume write quota.
  const result=await db.batch(statements);
  if(result.some(r=>!r.success))throw Error('Mail event save unconfirmed');
  const stored=await db.prepare('SELECT event_sha256 FROM life_report_mail_events WHERE event_id=?').bind(event.eventId).all<{event_sha256:string}>();
  if(!stored.success)throw Error('Mail event save unconfirmed');
  if(!stored.results[0])return {applied:false,unchanged:true};
  return {applied:result[1].results.length===1,duplicate:result[0].results.length===0&&stored.results[0].event_sha256===digest,conflict:stored.results[0].event_sha256!==digest};
}
