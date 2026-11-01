import type {D1Database} from '@cloudflare/workers-types';
import {maskedReportRecipient,reportVerificationHash,type reportMailVault} from './report-mail-vault';
import {readReportPreferences,reserveReportWrite} from './report-settings';
export type MailVault=Awaited<ReturnType<typeof reportMailVault>>;
export type MailContact={owner_id:number;email_sealed:string;fingerprint:string;revision:number;verified_at:number|null;enabled_at:number|null;paused_reason:string|null};

export async function reportMailOwner(db:D1Database,ownerId:number,seconds:number){
  if(!Number.isSafeInteger(ownerId)||ownerId<1||!Number.isSafeInteger(seconds)||seconds<0)throw Error('Mail owner required');
  const rows=await db.prepare('SELECT id FROM users WHERE id=? AND permission=1 AND (access_expires_at IS NULL OR access_expires_at>?)').bind(ownerId,seconds).all();
  if(!rows.success)throw Error('Mail permission read unavailable');return rows.results.length===1;
}

export async function readMailContact(db:D1Database,ownerId:number){
  const rows=await db.prepare('SELECT owner_id,email_sealed,fingerprint,revision,verified_at,enabled_at,paused_reason FROM life_report_mail_contacts WHERE owner_id=?').bind(ownerId).all<MailContact>();
  if(!rows.success)throw Error('Mail contact unavailable');return rows.results[0]??null;
}

export async function reportMailContactState(db:D1Database,ownerId:number,vault:MailVault){
  const row=await readMailContact(db,ownerId);
  const settings=await db.prepare('SELECT email_enabled,revision FROM life_report_preferences WHERE owner_id=?').bind(ownerId).all<{email_enabled:number;revision:number}>();
  if(!settings.success)throw Error('Mail settings unavailable');
  let masked:string|null=null;
  if(row){const email=await vault.open(ownerId,row.email_sealed);if(await vault.fingerprint(ownerId,email)!==row.fingerprint)throw Error('Mail contact damaged');masked=maskedReportRecipient(email);}
  return {ownerId,maskedRecipient:masked,contactRevision:row?.revision??0,preferencesRevision:settings.results[0]?.revision??0,verified:Boolean(row?.verified_at),enabled:Boolean(row?.verified_at&&row.enabled_at!==null&&!row.paused_reason&&settings.results[0]?.email_enabled===1),pausedReason:row?.paused_reason??null};
}

export async function saveReportRecipient(options:{db:D1Database;ownerId:number;email:string;baseRevision:number;vault:MailVault;now?:Date}){
  const {db,ownerId,vault}=options,seconds=Math.floor((options.now??new Date()).getTime()/1000);
  if(!await reportMailOwner(db,ownerId,seconds))throw Error('Owner access required');
  const fingerprint=await vault.fingerprint(ownerId,options.email),current=await readMailContact(db,ownerId);
  if(current?.fingerprint===fingerprint)return {saved:true,...await reportMailContactState(db,ownerId,vault)};
  if((current?.revision??0)!==options.baseRevision)return {saved:false,...await reportMailContactState(db,ownerId,vault)};
  if(!await reserveReportWrite(db))return {saved:false,paused:true,...await reportMailContactState(db,ownerId,vault)};
  const sealed=await vault.seal(ownerId,options.email);
  const rows=await db.batch([
    db.prepare(`INSERT INTO life_report_mail_contacts(owner_id,email_sealed,fingerprint,revision,updated_at)
      SELECT ?,?,?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM life_report_mail_contacts WHERE owner_id=?)
      ON CONFLICT(owner_id) DO UPDATE SET email_sealed=excluded.email_sealed,fingerprint=excluded.fingerprint,revision=revision+1,verified_at=NULL,enabled_at=NULL,paused_reason=NULL,updated_at=excluded.updated_at
      WHERE revision=? RETURNING revision`).bind(ownerId,sealed,fingerprint,seconds,options.baseRevision,ownerId,options.baseRevision),
    // A changed recipient always switches off delivery, without overwriting any clocks/other flags.
    db.prepare('UPDATE life_report_preferences SET email_enabled=0,revision=revision+1,updated_at=? WHERE owner_id=? AND changes()>0').bind(seconds,ownerId),
  ]);
  if(rows.some(row=>!row.success))throw Error('Mail recipient save unconfirmed');
  return {saved:rows[0].results.length===1,...await reportMailContactState(db,ownerId,vault)};
}

export async function verifyReportRecipient(options:{db:D1Database;ownerId:number;token:string;vault:MailVault;now?:Date}){
  const {db,ownerId,vault}=options,seconds=Math.floor((options.now??new Date()).getTime()/1000);
  if(!await reportMailOwner(db,ownerId,seconds))throw Error('Owner access required');
  const hash=await reportVerificationHash(options.token),contact=await readMailContact(db,ownerId);
  const tokens=await db.prepare('SELECT contact_revision,fingerprint,expires_at,used_at FROM life_report_mail_verifications WHERE token_hash=? AND owner_id=?').bind(hash,ownerId).all<{contact_revision:number;fingerprint:string;expires_at:number;used_at:number|null}>();
  if(!tokens.success)throw Error('Verification read unavailable');
  const token=tokens.results[0];
  if(!token||!contact||contact.revision!==token.contact_revision||contact.fingerprint!==token.fingerprint||contact.paused_reason)return {verified:false};
  if(token.used_at!==null)return {verified:contact.verified_at!==null};
  if(token.expires_at<=seconds)return {verified:false};
  // Decryptability and account-bound HMAC must be valid before accepting the proof.
  const email=await vault.open(ownerId,contact.email_sealed);if(await vault.fingerprint(ownerId,email)!==contact.fingerprint)throw Error('Mail contact damaged');
  if(!await reserveReportWrite(db))return {verified:false,paused:true};
  const result=await db.batch([
    db.prepare(`UPDATE life_report_mail_contacts SET verified_at=?,updated_at=? WHERE owner_id=? AND revision=? AND fingerprint=? AND paused_reason IS NULL
      AND EXISTS(SELECT 1 FROM life_report_mail_verifications WHERE token_hash=? AND owner_id=? AND used_at IS NULL AND expires_at>?) RETURNING owner_id`).bind(seconds,seconds,ownerId,token.contact_revision,token.fingerprint,hash,ownerId,seconds),
    db.prepare('UPDATE life_report_mail_verifications SET used_at=? WHERE token_hash=? AND owner_id=? AND used_at IS NULL AND changes()>0 RETURNING token_hash').bind(seconds,hash,ownerId),
  ]);
  if(result.some(row=>!row.success))throw Error('Verification save unconfirmed');
  if(result[1].results.length===1)return {verified:true};
  const latest=await readMailContact(db,ownerId);
  const consumed=await db.prepare('SELECT used_at FROM life_report_mail_verifications WHERE token_hash=? AND owner_id=?').bind(hash,ownerId).all<{used_at:number|null}>();
  if(!consumed.success)throw Error('Verification read unavailable');
  return {verified:Boolean(latest&&latest.revision===token.contact_revision&&latest.fingerprint===token.fingerprint&&latest.verified_at!==null&&consumed.results[0]?.used_at!==null&&consumed.results.length)};
}

export async function setReportEmailEnabled(options:{db:D1Database;ownerId:number;enabled:boolean;contactRevision:number;baseRevision:number;now?:Date}){
  const {db,ownerId}=options,seconds=Math.floor((options.now??new Date()).getTime()/1000);
  if(!await reportMailOwner(db,ownerId,seconds))throw Error('Owner access required');
  const prefs=await readReportPreferences(db,ownerId),contact=await readMailContact(db,ownerId);
  if(options.enabled&&(!contact?.verified_at||contact.paused_reason||contact.revision!==options.contactRevision))return {saved:false,reason:'verification-required'};
  const flags=await db.prepare('SELECT email_enabled FROM life_report_preferences WHERE owner_id=?').bind(ownerId).all<{email_enabled:number}>();
  if(!flags.success)throw Error('Mail settings unavailable');
  if((flags.results[0]?.email_enabled===1)===options.enabled&&(!options.enabled||contact?.enabled_at!==null))return {saved:true,reason:'unchanged'};
  if(prefs.revision!==options.baseRevision)return {saved:false,reason:'conflict'};
  if(!await reserveReportWrite(db))return {saved:false,reason:'write-budget'};
  const result=await db.batch([db.prepare(`INSERT INTO life_report_preferences(owner_id,email_enabled,revision)
    SELECT ?,?,1 WHERE (?=0 OR EXISTS(SELECT 1 FROM life_report_preferences WHERE owner_id=?)) AND (?=0 OR EXISTS(SELECT 1 FROM life_report_mail_contacts WHERE owner_id=? AND revision=? AND verified_at IS NOT NULL AND paused_reason IS NULL))
    ON CONFLICT(owner_id) DO UPDATE SET email_enabled=excluded.email_enabled,revision=revision+1,updated_at=? WHERE revision=?
      AND (?=0 OR EXISTS(SELECT 1 FROM life_report_mail_contacts WHERE owner_id=? AND revision=? AND verified_at IS NOT NULL AND paused_reason IS NULL)) RETURNING revision`).bind(ownerId,options.enabled?1:0,options.baseRevision,ownerId,options.enabled?1:0,ownerId,options.contactRevision,seconds,options.baseRevision,options.enabled?1:0,ownerId,options.contactRevision),
    db.prepare('UPDATE life_report_mail_contacts SET enabled_at=? WHERE owner_id=? AND changes()>0').bind(options.enabled?seconds:null,ownerId),
  ]);
  if(result.some(row=>!row.success))throw Error('Mail enable save unconfirmed');
  return {saved:result[0].results.length===1,reason:result[0].results.length?'saved':'conflict'};
}
