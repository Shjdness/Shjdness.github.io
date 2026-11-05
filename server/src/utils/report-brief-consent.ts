import type {D1Database} from '@cloudflare/workers-types';
import {reportMailOwner} from './report-mail-contacts';
import {reserveReportWrite} from './report-settings';
export async function readBriefConsent(db:D1Database,owner:number){
 const result=await db.prepare('SELECT revision,enabled_at FROM life_report_brief_consent WHERE owner_id=? AND scope_version=3').bind(owner).all<{revision:number;enabled_at:number|null}>();
 if(!result.success)throw Error('Brief consent unavailable');const row=result.results[0];
 return {ownerId:owner,scopeVersion:3,revision:row?.revision??0,enabled:row?.enabled_at!=null,enabledAt:row?.enabled_at??null};
}
/** Separate mail-only grant; never changes AI consent or the delivery schedule. */
export async function setBriefConsent(options:{db:D1Database;owner:number;enabled:boolean;baseRevision:number;allowNamedMail?:boolean;now?:Date}){
 const {db,owner,enabled}=options,seconds=Math.floor((options.now??new Date()).getTime()/1000);
 if(!await reportMailOwner(db,owner,seconds))throw Error('Owner access required');
 if(!Number.isSafeInteger(options.baseRevision)||options.baseRevision<0)throw Error('Invalid consent revision');
 const old=await readBriefConsent(db,owner);
 if(enabled&&options.allowNamedMail!==true)return {...old,saved:false,reason:'consent-required'};
 if(old.revision!==options.baseRevision)return {...old,saved:false,reason:'conflict'};
 if(old.enabled===enabled)return {...old,saved:true,reason:'unchanged'};
 if(enabled&&!await reserveReportWrite(db))return {...old,saved:false,reason:'write-budget'};
 const result=await db.prepare(`INSERT INTO life_report_brief_consent(owner_id,scope_version,enabled_at,revision,updated_at)
   SELECT ?,3,?,1,? WHERE (?=0 OR EXISTS(SELECT 1 FROM life_report_brief_consent WHERE owner_id=?)) AND EXISTS(SELECT 1 FROM users WHERE id=? AND permission=1 AND (access_expires_at IS NULL OR access_expires_at>?))
   ON CONFLICT(owner_id) DO UPDATE SET enabled_at=excluded.enabled_at,revision=revision+1,updated_at=excluded.updated_at
   WHERE revision=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND permission=1 AND (access_expires_at IS NULL OR access_expires_at>?))
   RETURNING owner_id`).bind(owner,enabled?seconds:null,seconds,options.baseRevision,owner,owner,seconds,options.baseRevision,owner,seconds).all();
 if(!result.success)throw Error('Brief consent save unconfirmed');
 return {...await readBriefConsent(db,owner),saved:result.results.length===1,reason:result.results.length?'saved':'conflict'};
}
