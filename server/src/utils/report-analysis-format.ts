/** Shared with backup validation and UI. No database, credentials or provider client. */
export const REPORT_AI_MODEL='deepseek-flash';
export const REPORT_AI_PROMPT_VERSION=1;
export type ReportAnalysis={summary:string;observations:string[];actions:string[]};

export function analysisValue(value:unknown):ReportAnalysis {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid analysis');
  const v=value as Record<string,unknown>;
  const plain=(s:unknown,max:number):s is string=>typeof s==='string'&&s.trim().length>0&&s.length<=max&&!/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]|https?:\/\//i.test(s);
  if(!plain(v.summary,600)||!Array.isArray(v.observations)||v.observations.length>3||!v.observations.every(s=>plain(s,240))||!Array.isArray(v.actions)||v.actions.length>3||!v.actions.every(s=>plain(s,240)))throw Error('Invalid analysis');
  return {summary:v.summary.trim(),observations:v.observations.map(s=>s.trim()),actions:v.actions.map(s=>s.trim())};
}

export async function reportDigest(text:string){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}

export async function reportAIRequestKey(record:{id:number;ownerId:number;sha256:string}){
  if(!Number.isSafeInteger(record.id)||record.id<=0||!Number.isSafeInteger(record.ownerId)||record.ownerId<=0||!/^[a-f0-9]{64}$/.test(record.sha256))throw Error('Stored report required');
  return reportDigest(`report-analysis:v${REPORT_AI_PROMPT_VERSION}:${REPORT_AI_MODEL}:${record.ownerId}:${record.id}:${record.sha256}`);
}

export type StoredReportAnalysis={requestKey:string;ownerId:number;reportId:number;snapshotSha256:string;model:typeof REPORT_AI_MODEL;promptVersion:1;state:'pending'|'succeeded'|'statistics'|'unknown';reason:string|null;analysisJson:string|null;analysisSha256:string|null;createdAt:number;updatedAt:number};

/** Validates the report binding as well as the result. Digest is corruption detection, not a signature. */
export async function validateStoredAnalysis(value:StoredReportAnalysis,report:{id:number;ownerId:number;sha256:string}){
  if(!value||value.ownerId!==report.ownerId||value.reportId!==report.id||value.snapshotSha256!==report.sha256||value.model!==REPORT_AI_MODEL||value.promptVersion!==1||value.requestKey!==await reportAIRequestKey(report)||!Number.isSafeInteger(value.createdAt)||!Number.isSafeInteger(value.updatedAt)||value.createdAt<0||value.updatedAt<value.createdAt)throw Error('Analysis binding mismatch');
  if(value.state==='succeeded'){
    if(value.reason!==null||typeof value.analysisJson!=='string'||value.analysisJson.length>8192||value.analysisSha256!==await reportDigest(value.analysisJson))throw Error('Damaged analysis');
    return analysisValue(JSON.parse(value.analysisJson));
  }
  if(!['pending','statistics','unknown'].includes(value.state)||value.analysisJson!==null||value.analysisSha256!==null||
    (value.state==='pending'?value.reason!==null:!['budget-or-duplicate','unavailable','interrupted'].includes(value.reason??'')))throw Error('Invalid analysis state');
  return null;
}
