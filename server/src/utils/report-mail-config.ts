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
  if(vault&&env.REPORT_MAIL_ENABLED==='true'&&env.REPORT_MAIL_PROVIDER==='resend'){
    try{
      const webhook=env.REPORT_MAIL_WEBHOOK_SECRET??'';
      if(webhook.length>128)throw Error();
      const decoded=webhook.startsWith('whsec_')?atob(webhook.slice(6)):'';
      if(decoded.length<16||decoded.length>64||protectedSecrets.includes(webhook)||webhook===env.REPORT_MAIL_API_KEY||webhook===env.REPORT_MAIL_VAULT_KEY)throw Error();
      provider=reportMailProvider({kind:'resend',identity:env.REPORT_MAIL_PROVIDER_ID??'',apiKey:env.REPORT_MAIL_API_KEY??'',from:env.REPORT_MAIL_FROM??'',disallowedSecrets:[...protectedSecrets,webhook,env.REPORT_MAIL_VAULT_KEY??'']});
    }catch{/* no partial enabling */}
  }
  return {vault,provider,storageConfigured:Boolean(vault),deliveryConfigured:Boolean(provider)};
}
