import type {D1Database} from '@cloudflare/workers-types';
import {reportMailOwner} from './report-mail-contacts';
import {reserveReportWrite} from './report-settings';
export async function readReportAIConsent(db:D1Database,ownerId:number){
  const rows=await db.prepare(`SELECT p.revision,p.ai_enabled,c.enabled_at FROM life_report_preferences p LEFT JOIN life_report_ai_consent c ON c.owner_id=p.owner_id WHERE p.owner_id=?`).bind(ownerId).all<{revision:number;ai_enabled:number;enabled_at:number|null}>();
  if(!rows.success)throw Error('AI settings unavailable');const row=rows.results[0];
  return {ownerId,revision:row?.revision??0,enabled:Boolean(row?.ai_enabled===1&&row.enabled_at!==null&&row.enabled_at!==undefined),configuredEnabled:row?.ai_enabled===1,enabledAt:row?.enabled_at??null};
}
export async function setReportAIConsent(options:{db:D1Database;ownerId:number;enabled:boolean;baseRevision:number;allowNumericAnalysis?:boolean;now?:Date}){
  const {db,ownerId,enabled}=options,seconds=Math.floor((options.now??new Date()).getTime()/1000);
  if(!await reportMailOwner(db,ownerId,seconds))throw Error('Owner access required');
  if(enabled&&options.allowNumericAnalysis!==true)return {saved:false,reason:'consent-required'};
  const old=await readReportAIConsent(db,ownerId);
  if(old.enabled===enabled&&old.configuredEnabled===enabled&&(!enabled?old.enabledAt===null:true))return {saved:true,...old};
  if(old.revision!==options.baseRevision)return {saved:false,reason:'conflict',...old};
  // Consent withdrawal remains possible when activity admission is exhausted.
  if(enabled&&!await reserveReportWrite(db))return {saved:false,reason:'write-budget',...old};
  const results=await db.batch([
    db.prepare(`INSERT INTO life_report_preferences(owner_id,ai_enabled,revision) SELECT ?,?,1 WHERE ?=0 OR EXISTS(SELECT 1 FROM life_report_preferences WHERE owner_id=?)
      ON CONFLICT(owner_id) DO UPDATE SET ai_enabled=excluded.ai_enabled,revision=revision+1,updated_at=? WHERE revision=? RETURNING owner_id`).bind(ownerId,enabled?1:0,options.baseRevision,ownerId,seconds,options.baseRevision),
    db.prepare(`INSERT INTO life_report_ai_consent(owner_id,enabled_at,scope_version) SELECT ?,?,1 WHERE changes()>0
      ON CONFLICT(owner_id) DO UPDATE SET enabled_at=excluded.enabled_at,scope_version=1`).bind(ownerId,enabled?seconds:null),
  ]);
  if(results.some(r=>!r.success))throw Error('AI setting save unconfirmed');
  return {saved:results[0].results.length===1,...await readReportAIConsent(db,ownerId)};
}
