import type {Env} from '../db/db';
import {reportMailVault} from './report-mail-vault';
import {reportMailProvider} from './report-mail-provider';
import type {MailVault} from './report-mail-contacts';
import type {ReportMailProvider} from './report-mail-delivery';

/** Do not persist/cache configuration or expose Secret values. Safe to call with
 * missing optional bindings; no database reads or provider requests occur here.
 * The identity must change when the provider account/from address changes. */
export async function reportMailConfiguration(env:Env){
  const protectedSecrets=[env.JWT_SECRET,env.DEEPSEEK_API_KEY,env.RSS_SYNC_TOKEN,env.GUEST_ACCESS_CODE,env.S3_SECRET_ACCESS_KEY,env.S3_ACCESS_KEY_ID,env.RIN_GITHUB_CLIENT_SECRET,env.GITHUB_CLIENT_SECRET].filter((s):s is string=>Boolean(s));
  let vault:MailVault|null=null,provider:ReportMailProvider|null=null;
  try{if(env.REPORT_MAIL_VAULT_KEY)vault=await reportMailVault(env.REPORT_MAIL_VAULT_KEY,[...protectedSecrets,env.REPORT_MAIL_API_KEY??'',env.REPORT_MAIL_WEBHOOK_SECRET??'']);}catch{/* fail closed without returning Secret/error values */}
  if(vault&&env.REPORT_OUTBOUND_PAUSED!=='true'&&env.REPORT_MAIL_ENABLED==='true'){
    try{
      const receiver=reportMailReceiverConfiguration(env);if(!receiver)throw Error();
      provider=reportMailProvider({kind:receiver.kind,identity:receiver.providerIdentity,apiKey:env.REPORT_MAIL_API_KEY??'',from:env.REPORT_MAIL_FROM??'',disallowedSecrets:[...protectedSecrets,receiver.secret,env.REPORT_MAIL_VAULT_KEY??'']});
    }catch{/* no partial enabling */}
  }
  return {vault,provider,storageConfigured:Boolean(vault),deliveryConfigured:Boolean(provider)};
}

/** Authenticated outcomes must still be accepted after delivery is switched off or
 * the vault/API key becomes unavailable, so suppression can finish safely. */
export function reportMailReceiverConfiguration(env:Env):{kind:'resend'|'brevo';secret:string;providerIdentity:string}|null{
  const secret=env.REPORT_MAIL_WEBHOOK_SECRET??'',identity=env.REPORT_MAIL_PROVIDER_ID??'',kind=env.REPORT_MAIL_PROVIDER;
  try{
    if((kind!=='resend'&&kind!=='brevo')||!/^[A-Za-z0-9_-]{1,64}$/.test(identity)||secret.length>128)return null;
    if(kind==='resend'){
      if(!secret.startsWith('whsec_'))return null;const key=atob(secret.slice(6));if(key.length<16||key.length>64)return null;
    }else if(secret.startsWith('whsec_')||!/^[A-Za-z0-9_-]{43,128}$/.test(secret))return null;
    if([env.JWT_SECRET,env.DEEPSEEK_API_KEY,env.RSS_SYNC_TOKEN,env.GUEST_ACCESS_CODE,env.S3_SECRET_ACCESS_KEY,env.S3_ACCESS_KEY_ID,env.RIN_GITHUB_CLIENT_SECRET,env.GITHUB_CLIENT_SECRET,env.REPORT_MAIL_API_KEY,env.REPORT_MAIL_VAULT_KEY].some(s=>s&&s===secret))return null;
    return {kind,secret,providerIdentity:identity};
  }catch{return null;}
}
