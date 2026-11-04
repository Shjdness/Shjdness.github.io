import type {D1Database} from '@cloudflare/workers-types';
import type {CheckinVault} from './checkin-vault';
import type {LifeReportPreview} from './life-report';
import {briefFactsValue,type BriefFacts,type BriefContext} from './report-brief-data';
import {rssDigestValue,type RssDigest} from './report-rss-digest';

type Saved={id:number;sha256:string;report:LifeReportPreview};
export type BriefRow={report_id:number;owner_id:number;report_sha256:string;version:number;outbound_eligible:number;scheduled_at:number;facts_sealed:string;facts_hmac:string;rss_sealed:string|null;rss_hmac:string|null;checkin_hmac:string;content_hmac:string;created_at:number};
const hmac=(value:string)=>/^[A-Za-z0-9+/]{43}=$/.test(value);
function identity(row:Pick<BriefRow,'scheduled_at'|'facts_hmac'|'rss_hmac'|'checkin_hmac'>){return {version:1,scheduledAt:row.scheduled_at,factsHmac:row.facts_hmac,rssHmac:row.rss_hmac,checkinHmac:row.checkin_hmac};}
export async function sealBriefSnapshot(vault:CheckinVault,context:BriefContext,sha:string,input:BriefFacts,reading:RssDigest|null,checkinHmac:string){
 if(!/^[a-f0-9]{64}$/.test(sha)||!hmac(checkinHmac))throw Error('Invalid brief binding');
 const facts=briefFactsValue(input,context),rss=reading===null?null:rssDigestValue(reading);
 if(rss&&Date.parse(rss.toExclusive)!==Math.floor(context.capturedAt.getTime()/1000)*1000)throw Error('Brief RSS capture mismatch');
 const factsSealed=await vault.sealPayload(context.owner,'report-brief',sha,facts),factsHmac=await vault.payloadDigest(context.owner,'report-brief',sha,facts);
 const rssSealed=rss?await vault.sealPayload(context.owner,'report-reading',sha,rss):null,rssHmac=rss?await vault.payloadDigest(context.owner,'report-reading',sha,rss):null;
 const row={scheduled_at:Math.floor(context.scheduledFor.getTime()/1000),facts_hmac:factsHmac,rss_hmac:rssHmac,checkin_hmac:checkinHmac};
 return {...row,facts_sealed:factsSealed,rss_sealed:rssSealed,content_hmac:await vault.payloadDigest(context.owner,'report-brief-binding',sha,identity(row))};
}
/** SAME transaction as first numeric + selected-checkin INSERTs. No attachment
 * to old reports, no replace-on-conflict, no plaintext names in SQL bindings. */
export function briefInsertStatement(db:D1Database,owner:number,report:LifeReportPreview,sha:string,sealed:Awaited<ReturnType<typeof sealBriefSnapshot>>){
 const p=report.period;
 return db.prepare(`INSERT INTO life_report_briefs(report_id,owner_id,report_sha256,version,outbound_eligible,scheduled_at,facts_sealed,facts_hmac,rss_sealed,rss_hmac,checkin_hmac,content_hmac,created_at)
   SELECT r.id,r.owner_id,r.snapshot_sha256,1,1,?,?,?,?,?,?,?,? FROM life_reports r JOIN life_report_checkin_snapshots x ON x.report_id=r.id AND x.owner_id=r.owner_id
   WHERE r.owner_id=? AND r.kind=? AND r.period_start=? AND r.period_end=? AND r.snapshot_sha256=? AND x.report_sha256=r.snapshot_sha256 AND x.content_hmac=? AND x.outbound_eligible=1 AND changes()>0
   ON CONFLICT(report_id) DO NOTHING`).bind(sealed.scheduled_at,sealed.facts_sealed,sealed.facts_hmac,sealed.rss_sealed,sealed.rss_hmac,sealed.checkin_hmac,sealed.content_hmac,Math.floor(Date.parse(report.generatedAt)/1000),owner,p.kind,Date.parse(p.start)/1000,Date.parse(p.end)/1000,sha,sealed.checkin_hmac);
}
export async function decodeBriefRow(vault:CheckinVault,owner:number,saved:Saved,row:BriefRow){
 if(saved.report.ownerId!==owner||row.owner_id!==owner||row.report_id!==saved.id||row.report_sha256!==saved.sha256||row.version!==1||![0,1].includes(row.outbound_eligible)||row.created_at!==Math.floor(Date.parse(saved.report.generatedAt)/1000)||!Number.isSafeInteger(row.scheduled_at)||!hmac(row.facts_hmac)||!hmac(row.checkin_hmac)||!hmac(row.content_hmac)||(row.rss_hmac===null)!==(row.rss_sealed===null)||row.rss_hmac!==null&&!hmac(row.rss_hmac))throw Error('Brief binding unavailable');
 const context:BriefContext={owner,period:saved.report.period,capturedAt:new Date(saved.report.generatedAt),scheduledFor:new Date(row.scheduled_at*1000)};
 const facts=briefFactsValue(await vault.openPayload(owner,'report-brief',saved.sha256,row.facts_sealed),context);
 const rss=row.rss_sealed===null?null:rssDigestValue(await vault.openPayload(owner,'report-reading',saved.sha256,row.rss_sealed));
 if(rss&&Date.parse(rss.toExclusive)!==Math.floor(Date.parse(facts.capturedAt)/1000)*1000)throw Error('Brief RSS capture mismatch');
 if(await vault.payloadDigest(owner,'report-brief',saved.sha256,facts)!==row.facts_hmac||rss&&await vault.payloadDigest(owner,'report-reading',saved.sha256,rss)!==row.rss_hmac||await vault.payloadDigest(owner,'report-brief-binding',saved.sha256,identity(row))!==row.content_hmac)throw Error('Brief authentication failed');
 return {context,facts,rss,contentHmac:row.content_hmac,checkinHmac:row.checkin_hmac,outboundEligible:row.outbound_eligible===1};
}
export async function readReportBrief(db:D1Database,vault:CheckinVault,owner:number,saved:Saved){
 // outboundEligible means live-derived, not mail consent. Senders MUST also
 // check the independent scope3 revision and selected-checkin source guard.
 if(saved.report.ownerId!==owner)throw Error('Brief owner mismatch');
 const rows=await db.prepare('SELECT * FROM life_report_briefs WHERE owner_id=? AND report_id=?').bind(owner,saved.id).all<BriefRow>();
 if(!rows.success)throw Error('Brief read unavailable');if(!rows.results[0])return null;
 const brief=await decodeBriefRow(vault,owner,saved,rows.results[0]);
 const checkin=await db.prepare('SELECT content_hmac FROM life_report_checkin_snapshots WHERE owner_id=? AND report_id=? AND report_sha256=?').bind(owner,saved.id,saved.sha256).all<{content_hmac:string}>();
 if(!checkin.success||checkin.results.length!==1||checkin.results[0].content_hmac!==brief.checkinHmac)throw Error('Brief check-in binding mismatch');
 return brief;
}
