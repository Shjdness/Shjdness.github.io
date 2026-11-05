import type {D1Database} from '@cloudflare/workers-types';
import {reportMailOwner} from './report-mail-contacts';
import {reserveReportWrite} from './report-settings';
export async function readSelectedAIConsent(db:D1Database,owner:number){
 const result=await db.prepare('SELECT revision,enabled_at FROM life_report_selected_ai_consent WHERE owner_id=? AND scope_version=2').bind(owner).all<{revision:number;enabled_at:number|null}>();
 if(!result.success)throw Error('Selected AI settings unavailable');const row=result.results[0];
 return {ownerId:owner,scopeVersion:2,revision:row?.revision??0,enabled:row?.enabled_at!=null,enabledAt:row?.enabled_at??null};
}
export async function setSelectedAIConsent(options:{db:D1Database;owner:number;enabled:boolean;baseRevision:number;allowSelectedAnalysis?:boolean;now?:Date}){
 const {db,owner,enabled}=options,at=Math.floor((options.now??new Date()).getTime()/1000);
 if(!await reportMailOwner(db,owner,at))throw Error('Owner access required');
 if(!Number.isSafeInteger(options.baseRevision)||options.baseRevision<0)throw Error('Invalid revision');
 const old=await readSelectedAIConsent(db,owner);
 if(enabled&&options.allowSelectedAnalysis!==true)return {...old,saved:false,reason:'consent-required'};
 if(old.revision!==options.baseRevision)return {...old,saved:false,reason:'conflict'};
 if(old.enabled===enabled)return {...old,saved:true,reason:'unchanged'};
 if(enabled&&!await reserveReportWrite(db))return {...old,saved:false,reason:'write-budget'};
 const rows=await db.prepare(`INSERT INTO life_report_selected_ai_consent(owner_id,scope_version,enabled_at,revision,updated_at)
  SELECT ?,2,?,1,? WHERE (?=0 OR EXISTS(SELECT 1 FROM life_report_selected_ai_consent WHERE owner_id=?))
  AND EXISTS(SELECT 1 FROM users WHERE id=? AND permission=1 AND (access_expires_at IS NULL OR access_expires_at>?))
  ON CONFLICT(owner_id) DO UPDATE SET enabled_at=excluded.enabled_at,revision=revision+1,updated_at=excluded.updated_at
  WHERE revision=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND permission=1 AND (access_expires_at IS NULL OR access_expires_at>?)) RETURNING owner_id`).bind(owner,enabled?at:null,at,options.baseRevision,owner,owner,at,options.baseRevision,owner,at).all();
 if(!rows.success)throw Error('Selected AI settings save unconfirmed');return {...await readSelectedAIConsent(db,owner),saved:rows.results.length===1,reason:rows.results.length?'saved':'conflict'};
}
