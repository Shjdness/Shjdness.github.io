import type {D1Database} from '@cloudflare/workers-types';
import type {CheckinVault} from './checkin-vault';
import {readReportCheckins,checkinSourceGuard} from './report-checkin-snapshot';
import {reportAIRequestKey,reportDigest} from './report-analysis-format';
import {REPORT_AI_MONTHLY_FEN,REPORT_AI_RESERVE_FEN,REPORT_AI_PRICE_REVIEW_BEFORE} from './report-ai';
import {reportSnapshot,type LifeReportPreview} from './life-report';
import {checkinAIRequest,analyzeCheckinReport} from './checkin-ai';
import {checkinAIInput,checkinAIAnalysis,type CheckinAIAnalysis} from './checkin-ai-format';
import {reserveReportWrite} from './report-settings';
type Saved={id:number;sha256:string;report:LifeReportPreview};
export type CheckinAnalysisView={state:'none'|'pending'|'succeeded'|'statistics'|'unknown';analysis:CheckinAIAnalysis|null;reason:string|null};
const empty:CheckinAnalysisView={state:'none',analysis:null,reason:null};
/** Owner-only orchestrator, not yet attached to any paid HTTP/cron entry. Reads
 * do not retry pending/unknown work. Results never enter the numeric JSON table. */
export async function readCheckinAnalysis(db:D1Database,vault:CheckinVault,owner:number,saved:Saved,now=new Date()):Promise<CheckinAnalysisView>{
 if(owner!==saved.report.ownerId||await reportDigest(JSON.stringify(reportSnapshot(owner,saved.report)))!==saved.sha256)throw Error('Report binding mismatch');
 const key=await reportAIRequestKey({id:saved.id,ownerId:owner,sha256:saved.sha256}),rows=await db.prepare('SELECT * FROM life_report_checkin_analyses WHERE owner_id=? AND report_id=?').bind(owner,saved.id).all<Record<string,unknown>>();if(!rows.success)throw Error('Check-in analysis unavailable');const r=rows.results[0];
 if(!r){const old=await db.prepare('SELECT request_key FROM life_report_analyses WHERE owner_id=? AND report_id=? UNION ALL SELECT request_key FROM life_report_ai_reservations WHERE request_key=?').bind(owner,saved.id,key).all();if(!old.success)throw Error('Prior analysis unavailable');return {...empty,...(old.results.length?{reason:'prior-analysis'}:{})};}
 if(r.owner_id!==owner||r.report_id!==saved.id||r.request_key!==key||r.report_sha256!==saved.sha256||r.scope_version!==2||typeof r.snapshot_hmac!=='string'||!Number.isSafeInteger(r.created_at)||!Number.isSafeInteger(r.updated_at)||Number(r.created_at)<0||Number(r.updated_at)<Number(r.created_at))throw Error('Check-in result binding mismatch');
 if(r.state==='succeeded'){
  if(r.reason!==null||typeof r.sealed_json!=='string'||typeof r.result_hmac!=='string')throw Error('Invalid sealed result');const extension=await readReportCheckins(db,vault,owner,saved);if(!extension||!('sources' in extension.snapshot)||await vault.payloadDigest(owner,'report-snapshot',saved.sha256,extension.snapshot)!==r.snapshot_hmac)throw Error('Result snapshot mismatch');
  const value=await vault.openPayload(owner,'report-analysis',key,r.sealed_json),analysis=checkinAIAnalysis(value,checkinAIInput(saved.report,extension.snapshot));if(await vault.payloadDigest(owner,'report-analysis',key,analysis)!==r.result_hmac)throw Error('Result authentication failed');return {state:'succeeded',analysis,reason:null};
 }
 if(r.sealed_json!==null||r.result_hmac!==null||!['pending','statistics','unknown'].includes(String(r.state))||(r.state==='pending'?r.reason!==null:!['budget-or-scope','unavailable','interrupted'].includes(String(r.reason))))throw Error('Invalid check-in analysis state');
 if(r.state==='pending'&&now.getTime()/1000-Number(r.updated_at)>=60)return {...empty,state:'unknown',reason:'interrupted'};return {state:r.state as CheckinAnalysisView['state'],analysis:null,reason:r.reason as string|null};
}
/** scope2Approved is a single explicit action, never the old numeric toggle.
 * Automatic scope2 consent and job eligibility must be added before cron wiring.
 * The current source+owner+extension guard is repeated in claim AND admission. */
export async function generateCheckinAnalysis(options:{db:D1Database;vault:CheckinVault;owner:number;saved:Saved;scope2Approved:boolean;enabled:boolean;apiKey?:string;now?:Date;timeoutMs?:number;fetcher?:(url:string,init:RequestInit)=>Promise<Response>}):Promise<CheckinAnalysisView>{
 const {db,vault,owner,saved}=options,now=options.now??new Date(),existing=await readCheckinAnalysis(db,vault,owner,saved,now);if(existing.state!=='none'||existing.reason)return existing;
 if(!options.enabled||!options.scope2Approved||!options.apiKey?.trim())return {...empty,reason:'not-approved'};if(!Number.isFinite(now.getTime())||now.getTime()>=REPORT_AI_PRICE_REVIEW_BEFORE)return {...empty,reason:'pricing-review'};
 const extension=await readReportCheckins(db,vault,owner,saved);if(!extension?.current||!('sources' in extension.snapshot))return {...empty,reason:'scope-changed'};const snapshot=extension.snapshot,prepared=checkinAIRequest(saved.report,snapshot);if(prepared.body===null)return {...empty,reason:prepared.reason};
 const key=await reportAIRequestKey({id:saved.id,ownerId:owner,sha256:saved.sha256}),hmac=await vault.payloadDigest(owner,'report-snapshot',saved.sha256,snapshot),source=checkinSourceGuard(owner,snapshot.rangeFrom,snapshot.toDateExclusive,snapshot.sources),seconds=Math.floor(now.getTime()/1000),token=crypto.randomUUID();
 const guard=`EXISTS(SELECT 1 FROM users u JOIN life_reports r ON r.owner_id=u.id JOIN life_report_checkin_snapshots s ON s.report_id=r.id AND s.owner_id=u.id WHERE u.id=? AND u.permission=1 AND (u.access_expires_at IS NULL OR u.access_expires_at>?) AND r.id=? AND r.snapshot_sha256=? AND s.outbound_eligible=1 AND s.report_sha256=r.snapshot_sha256 AND s.content_hmac=?) AND ${source.sql} AND NOT EXISTS(SELECT 1 FROM life_report_analyses WHERE owner_id=? AND report_id=?)`;
 const values=(at:number)=>[owner,at,saved.id,saved.sha256,hmac,...source.args,owner,saved.id];
 if(!await reserveReportWrite(db))return {...empty,reason:'write-budget'};
 const claim=await db.prepare(`INSERT INTO life_report_checkin_analyses(request_key,owner_id,report_id,report_sha256,snapshot_hmac,scope_version,claim_token,state,created_at,updated_at) SELECT ?,?,?,?,?,2,?,'pending',?,? WHERE ${guard} AND NOT EXISTS(SELECT 1 FROM life_report_ai_reservations WHERE request_key=?) ON CONFLICT DO NOTHING RETURNING request_key`).bind(key,owner,saved.id,saved.sha256,hmac,token,seconds,seconds,...values(seconds),key).all();if(!claim.success)throw Error('Check-in claim unconfirmed');if(!claim.results.length)return readCheckinAnalysis(db,vault,owner,saved,now);
 const result=await analyzeCheckinReport({...options,report:saved.report,snapshot,enabled:true,reserve:async()=>{
  const at=new Date(Math.max(now.getTime(),Date.now()));if(at.getTime()>=REPORT_AI_PRICE_REVIEW_BEFORE)return false;const month=new Date(at.getTime()+8*3600000).toISOString().slice(0,7);
  const rows=await db.batch([
   db.prepare('INSERT INTO life_report_ai_budget(month,reserved_fen) VALUES(?,0) ON CONFLICT DO NOTHING').bind(month),
   db.prepare(`INSERT INTO life_report_ai_reservations(request_key,month,reserved_fen) SELECT ?,month,? FROM life_report_ai_budget WHERE month=? AND reserved_fen+?<=? AND ${guard} AND EXISTS(SELECT 1 FROM life_report_checkin_analyses WHERE request_key=? AND claim_token=? AND state='pending') ON CONFLICT DO NOTHING RETURNING request_key`).bind(key,REPORT_AI_RESERVE_FEN,month,REPORT_AI_RESERVE_FEN,REPORT_AI_MONTHLY_FEN,...values(Math.floor(at.getTime()/1000)),key,token),
   db.prepare('UPDATE life_report_ai_budget SET reserved_fen=reserved_fen+? WHERE month=? AND changes()>0').bind(REPORT_AI_RESERVE_FEN,month),
  ]);if(rows.some(r=>!r.success))throw Error('Check-in admission unconfirmed');return rows[1].results.length===1;
 }});
 const analysis=result.mode==='ai'?result.analysis:null,sealed=analysis?await vault.sealPayload(owner,'report-analysis',key,analysis):null,resultHmac=analysis?await vault.payloadDigest(owner,'report-analysis',key,analysis):null,state=result.mode==='ai'?'succeeded':result.reason==='unavailable'?'unknown':'statistics',reason=result.mode==='ai'?null:result.reason==='budget-or-scope'?'budget-or-scope':'unavailable';
 const finish=await db.prepare("UPDATE life_report_checkin_analyses SET state=?,reason=?,sealed_json=?,result_hmac=?,updated_at=? WHERE request_key=? AND claim_token=? AND state='pending' RETURNING request_key").bind(state,reason,sealed,resultHmac,Math.max(seconds,Math.floor(Date.now()/1000)),key,token).all();if(!finish.success||finish.results.length!==1)throw Error('Check-in result save unconfirmed');return readCheckinAnalysis(db,vault,owner,saved,now);
}
