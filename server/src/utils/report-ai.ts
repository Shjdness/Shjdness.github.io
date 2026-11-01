import type {D1Database} from '@cloudflare/workers-types';
import type {LifeReportPreview} from './life-report';
import {reportSnapshot} from './report-history';

export const REPORT_AI_MODEL='deepseek-flash';
export const REPORT_AI_MONTHLY_FEN=1000;
export const REPORT_AI_RESERVE_FEN=5;
const PRICE_REVIEW_BEFORE=Date.parse('2026-12-01T00:00:00+08:00');

export async function reportAIRequestKey(record:{id:number;ownerId:number;sha256:string}){
  if(!Number.isSafeInteger(record.id)||record.id<=0||!Number.isSafeInteger(record.ownerId)||record.ownerId<=0||!/^[a-f0-9]{64}$/.test(record.sha256))throw Error('Stored report required');
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`report-analysis:v1:${REPORT_AI_MODEL}:${record.ownerId}:${record.id}:${record.sha256}`));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}

/** Only integer metrics leave the Worker. No dates, IDs, names, URLs or prose. */
export function reportAIInput(value:LifeReportPreview){
  const v=reportSnapshot(value.ownerId,value);
  return {periodDays:v.period.kind==='daily'?1:7,achievements:v.achievementsRecorded,completedTasks:v.tasksCompleted,
    newIdeas:v.ideasCreated,focusSessions:v.focus.completedSessions,recordedFocusMinutes:v.focus.recordedMinutes,
    earlyFocusSessions:v.focus.earlySessions,habitRecords:v.habitCompletions,noteDays:v.daysWithNotes};
}

/** Account-wide site budget, not a limit on other applications using the key.
 * No refunds: failures/timeouts may still have incurred provider charges. */
export async function reserveReportAI(db:D1Database,key:string,now=new Date()){
  if(!/^[a-f0-9]{64}$/.test(key)||!Number.isFinite(now.getTime()))throw Error('Invalid AI reservation');
  const month=new Date(now.getTime()+8*3600000).toISOString().slice(0,7);
  const results=await db.batch<Record<string,unknown>>([
    db.prepare('INSERT INTO life_report_ai_budget(month,reserved_fen) VALUES(?,0) ON CONFLICT(month) DO NOTHING').bind(month),
    db.prepare(`INSERT INTO life_report_ai_reservations(request_key,month,reserved_fen)
      SELECT ?,month,? FROM life_report_ai_budget WHERE month=? AND reserved_fen+?<=?
      ON CONFLICT(request_key) DO NOTHING RETURNING request_key`).bind(key,REPORT_AI_RESERVE_FEN,month,REPORT_AI_RESERVE_FEN,REPORT_AI_MONTHLY_FEN),
    // changes() refers to the immediately preceding INSERT in this transaction.
    db.prepare('UPDATE life_report_ai_budget SET reserved_fen=reserved_fen+? WHERE month=? AND changes()>0').bind(REPORT_AI_RESERVE_FEN,month),
  ]);
  if(results.some(row=>!row.success))throw Error('AI budget reservation unconfirmed');
  return results[1].results.length===1;
}

const INSTRUCTION='你是温和、务实的生活复盘助手。输入JSON只有统计数字，不含完整生活记录。不要编造具体经历、任务名称、人格评价或未提供的趋势，不把无记录说成没有努力。recordedFocusMinutes是保存值，不是独立核验用时；earlyFocusSessions为提前结束记录，习惯仅为次数没有完成率。仅返回JSON对象：summary为一句简短总结，observations为最多3条有依据的观察，actions为最多3条可选择的小行动。不要输出链接、HTML、Markdown或重新计算统计数字。';

type Analysis={summary:string;observations:string[];actions:string[]};
export type ReportAIResult={mode:'ai';analysis:Analysis;model:typeof REPORT_AI_MODEL}|{mode:'statistics';reason:'not-configured'|'pricing-review'|'budget-or-duplicate'|'unavailable'};

async function limitedJSON(response:Response,signal:AbortSignal){
  const reader=response.body?.getReader();if(!reader)throw Error('Missing response');
  const cancel=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',cancel,{once:true});
  let size=0,text='';const decoder=new TextDecoder();
  try{while(true){const part=await reader.read();if(signal.aborted)throw Error('Cancelled');if(part.done)break;size+=part.value.byteLength;if(size>32768)throw Error('Response limit');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
  finally{signal.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});}
}

function analysisValue(value:unknown):Analysis {
  if(!value||typeof value!=='object')throw Error('Invalid analysis');
  const v=value as Record<string,unknown>;
  const plain=(s:unknown,max:number):s is string=>typeof s==='string'&&s.trim().length>0&&s.length<=max&&!/<|>|https?:\/\//i.test(s);
  if(!plain(v.summary,600)||!Array.isArray(v.observations)||v.observations.length>3||!v.observations.every(s=>plain(s,240))||!Array.isArray(v.actions)||v.actions.length>3||!v.actions.every(s=>plain(s,240)))throw Error('Invalid analysis');
  return {summary:v.summary.trim(),observations:v.observations.map(s=>s.trim()),actions:v.actions.map(s=>s.trim())};
}

/** Internal adapter only; reserve MUST atomically acquire a durable unique job key.
 * No automatic retries, alternate providers, tools, search or logging of errors. */
export async function analyzeReport(options:{report:LifeReportPreview;apiKey?:string;enabled:boolean;reserve:()=>Promise<boolean>;fetcher?:(url:string,init:RequestInit)=>Promise<Response>;now?:Date;timeoutMs?:number}):Promise<ReportAIResult>{
  if(!options.enabled||!options.apiKey)return {mode:'statistics',reason:'not-configured'};
  const now=options.now??new Date();
  if(!Number.isFinite(now.getTime())||now.getTime()>=PRICE_REVIEW_BEFORE)return {mode:'statistics',reason:'pricing-review'};
  const metrics=reportAIInput(options.report);
  const body=JSON.stringify({model:REPORT_AI_MODEL,thinking:{type:'disabled'},stream:false,max_tokens:768,response_format:{type:'json_object'},messages:[{role:'system',content:INSTRUCTION},{role:'user',content:JSON.stringify(metrics)}]});
  // Fixed numeric projection + static prompt only. Limit before reservation/send.
  if(new TextEncoder().encode(body).byteLength>4096)throw Error('AI input limit');
  let acquired=false;
  try{acquired=await options.reserve();}catch{return {mode:'statistics',reason:'unavailable'};}
  if(!acquired)return {mode:'statistics',reason:'budget-or-duplicate'};
  const controller=new AbortController();
  const timeout=Math.max(1,Math.min(options.timeoutMs??20000,20000));
  let timer:ReturnType<typeof setTimeout>;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Provider deadline'));},timeout);});
  try{
    const work=async():Promise<ReportAIResult>=>{
    const response=await (options.fetcher??fetch)('https://api.deepseek.com/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${options.apiKey}`,'Content-Type':'application/json'},body,signal:controller.signal,redirect:'error',cache:'no-store',credentials:'omit'});
    if(controller.signal.aborted)throw Error('Cancelled');
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error('Provider unavailable');}
    const envelope=await limitedJSON(response,controller.signal);
    const choice=envelope?.choices?.[0];
    if(choice?.finish_reason!=='stop'||typeof choice.message?.content!=='string'||controller.signal.aborted)throw Error('Incomplete analysis');
    return {mode:'ai',model:REPORT_AI_MODEL,analysis:analysisValue(JSON.parse(choice.message.content))};
    };
    return await Promise.race([work(),deadline]);
  }catch{return {mode:'statistics',reason:'unavailable'};}
  finally{clearTimeout(timer!);}
}
