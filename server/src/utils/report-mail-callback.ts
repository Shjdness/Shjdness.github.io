import type {Env} from '../db/db';
import {reportMailReceiverConfiguration} from './report-mail-config';
import {verifyResendReportWebhook} from './report-mail-webhook';
import {applyReportMailEvent} from './report-mail-events';

export const REPORT_MAIL_WEBHOOK_PATH='/life/reports/mail/webhook/resend';
/** Runs before generic application/configuration initialization. Forged requests
 * never touch D1, and no response echoes provider bodies or credentials. */
export async function reportMailCallback(request:Request,env:Env){
  const reply=(status:number)=>new Response(null,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
  if(request.method!=='POST')return reply(405);
  const config=reportMailReceiverConfiguration(env);if(!config)return reply(503);
  let event;
  try{event=await verifyResendReportWebhook({request,...config});}catch{return reply(400);}
  if(!event)return reply(204);
  try{const result=await applyReportMailEvent(env.DB,event);return reply('conflict' in result&&result.conflict?409:204);}catch{return reply(503);}
}
