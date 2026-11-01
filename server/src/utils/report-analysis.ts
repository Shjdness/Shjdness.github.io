import type {D1Database} from '@cloudflare/workers-types';
import {reportSnapshot,type LifeReportPreview} from './life-report';
import {reserveReportWrite} from './report-settings';
import {analyzeReport,REPORT_AI_PRICE_REVIEW_BEFORE,reserveReportAI} from './report-ai';
import {REPORT_AI_MODEL,reportAIRequestKey,reportDigest,validateStoredAnalysis,type StoredReportAnalysis,type ReportAnalysis} from './report-analysis-format';

type Saved={id:number;sha256:string;report:LifeReportPreview};
export type AnalysisView={state:'none'|'pending'|'succeeded'|'statistics'|'unknown';analysis:ReportAnalysis|null;reason:string|null;model:typeof REPORT_AI_MODEL};
const empty:AnalysisView={state:'none',analysis:null,reason:null,model:REPORT_AI_MODEL};

function storedRow(row:Record<string,unknown>):StoredReportAnalysis{
  return {requestKey:row.request_key as string,ownerId:row.owner_id as number,reportId:row.report_id as number,snapshotSha256:row.snapshot_sha256 as string,model:row.model as typeof REPORT_AI_MODEL,promptVersion:row.prompt_version as 1,state:row.state as StoredReportAnalysis['state'],reason:row.reason as string|null,analysisJson:row.analysis_json as string|null,analysisSha256:row.analysis_sha256 as string|null,createdAt:row.created_at as number,updatedAt:row.updated_at as number};
}

export async function readReportAnalysis(db:D1Database,ownerId:number,saved:Saved,now=new Date()):Promise<AnalysisView>{
  if(saved.report.ownerId!==ownerId)throw Error('Report owner mismatch');
  const result=await db.prepare('SELECT * FROM life_report_analyses WHERE owner_id=? AND report_id=? AND model=? AND prompt_version=1').bind(ownerId,saved.id,REPORT_AI_MODEL).all<Record<string,unknown>>();
  if(!result.success)throw Error('Analysis read unavailable');
  const row=result.results[0];if(!row)return {...empty};
  const stored=storedRow(row),analysis=await validateStoredAnalysis(stored,{id:saved.id,ownerId,sha256:saved.sha256});
  // A crash/disconnected request may have reached the provider. Never take over
  // a stale pending call or release its spend reservation for an automatic retry.
  if(stored.state==='pending'&&now.getTime()/1000-stored.updatedAt>=60)return {...empty,state:'unknown',reason:'interrupted'};
  return {state:stored.state,analysis,reason:stored.reason,model:REPORT_AI_MODEL};
}

/** Internal orchestrator, not a background retry worker. Durable claim precedes
 * admission and provider submission; only the winning invocation may call AI. */
export async function generateReportAnalysis(options:{db:D1Database;ownerId:number;saved:Saved;enabled:boolean;apiKey?:string;now?:Date;fetcher?:(url:string,init:RequestInit)=>Promise<Response>;timeoutMs?:number}):Promise<AnalysisView>{
  const {db,ownerId,saved}=options,now=options.now??new Date();
  const existing=await readReportAnalysis(db,ownerId,saved,now);
  if(existing.state!=='none')return existing;
  if(!options.enabled||!options.apiKey?.trim())return {...empty,reason:'not-configured'};
  if(!Number.isFinite(now.getTime())||now.getTime()>=REPORT_AI_PRICE_REVIEW_BEFORE)return {...empty,reason:'pricing-review'};
  if(await reportDigest(JSON.stringify(reportSnapshot(ownerId,saved.report)))!==saved.sha256)throw Error('Report digest mismatch');
  if(!await reserveReportWrite(db))return {...empty,reason:'write-budget'};
  const key=await reportAIRequestKey({id:saved.id,ownerId,sha256:saved.sha256}),seconds=Math.floor(now.getTime()/1000);
  const claim=await db.prepare(`INSERT INTO life_report_analyses(request_key,owner_id,report_id,snapshot_sha256,model,state,created_at,updated_at)
    SELECT ?,?,?,?,?,'pending',?,? WHERE EXISTS(SELECT 1 FROM life_reports WHERE id=? AND owner_id=? AND snapshot_sha256=?)
    ON CONFLICT DO NOTHING RETURNING request_key`).bind(key,ownerId,saved.id,saved.sha256,REPORT_AI_MODEL,seconds,seconds,saved.id,ownerId,saved.sha256).all();
  if(!claim.success)throw Error('Analysis claim unconfirmed');
  if(!claim.results.length)return readReportAnalysis(db,ownerId,saved,now);
  // Key and raw provider diagnostics are never persisted. The adapter strips
  // all owner/date/free-text fields and retains reservations on unknown errors.
  const result=await analyzeReport({report:saved.report,apiKey:options.apiKey,enabled:true,now,timeoutMs:options.timeoutMs,fetcher:options.fetcher,reserve:()=>reserveReportAI(db,key,now)});
  const json=result.mode==='ai'?JSON.stringify(result.analysis):null;
  const digest=json?await reportDigest(json):null;
  const state=result.mode==='ai'?'succeeded':result.reason==='unavailable'?'unknown':'statistics';
  const reason=result.mode==='ai'?null:result.reason;
  const finish=await db.prepare(`UPDATE life_report_analyses SET state=?,reason=?,analysis_json=?,analysis_sha256=?,updated_at=?
    WHERE request_key=? AND owner_id=? AND report_id=? AND snapshot_sha256=? AND state='pending' RETURNING request_key`).bind(state,reason,json,digest,Math.max(seconds,Math.floor(Date.now()/1000)),key,ownerId,saved.id,saved.sha256).all();
  // Losing the result after a successful call must not turn a refresh into a
  // second call. A pending row stays durable and becomes unknown on read.
  if(!finish.success||finish.results.length!==1)throw Error('Analysis result save unconfirmed');
  return readReportAnalysis(db,ownerId,saved,now);
}
