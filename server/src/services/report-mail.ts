import Elysia,{t} from 'elysia';
import {setup} from '../setup';
import {getEnv} from '../utils/di';
import {allowBurst} from '../utils/rate-limit';
import {reportMailConfiguration} from '../utils/report-mail-config';
import {reportMailContactState,saveReportRecipient,setReportEmailEnabled,verifyReportRecipient} from '../utils/report-mail-contacts';
import {requestReportVerification} from '../utils/report-mail-delivery';
import {reportRecipient} from '../utils/report-mail-vault';

/** Private owner-only settings/proofs. No email/token in URLs or response;
 * schema errors never echo the submitted private body. */
export function ReportMailService(){
  const env=getEnv(),db=env.DB,revision=t.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER});
  const authorize=({uid,admin,set}:{uid?:number;admin?:boolean;set:{headers:Record<string,unknown>;status?:number|string}})=>{
    Object.assign(set.headers,{'Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','Vary':'Origin, Authorization'});
    if(!uid||!admin){set.status=403;return null;}return uid;
  };
  const limited=(owner:number)=>allowBurst(`life-report-mail:${owner}`,8);
  return new Elysia({aot:false}).use(setup())
    .onError(({code,set})=>{set.headers['Cache-Control']='private, no-store';if(code==='VALIDATION'||code==='PARSE'){set.status=400;return {code:'INVALID_MAIL_REQUEST'};}set.status=503;return {code:'MAIL_UNAVAILABLE'};})
    .get('/life/reports/mail',async context=>{
      const owner=authorize(context);if(!owner)return {code:'OWNER_REQUIRED'};
      const config=await reportMailConfiguration(env);
      return {storageConfigured:config.storageConfigured,deliveryConfigured:config.deliveryConfigured,...(config.vault?await reportMailContactState(db,owner,config.vault):{ownerId:owner,maskedRecipient:null,verified:false,enabled:false})};
    })
    .post('/life/reports/mail/recipient',async context=>{
      const owner=authorize(context);if(!owner)return {code:'OWNER_REQUIRED'};
      if(!limited(owner)){context.set.status=429;return {code:'MAIL_RATE_LIMIT'};}
      const config=await reportMailConfiguration(env);if(!config.vault){context.set.status=503;return {code:'MAIL_NOT_CONFIGURED'};}
      try{reportRecipient(context.body.email);}catch{context.set.status=400;return {code:'INVALID_MAIL_RECIPIENT'};}
      const result=await saveReportRecipient({db,ownerId:owner,vault:config.vault,...context.body});
      if(!result.saved)context.set.status='paused' in result&&result.paused?503:409;return result;
    },{body:t.Object({email:t.String({minLength:3,maxLength:254}),baseRevision:revision},{additionalProperties:false})})
    .post('/life/reports/mail/verification',async context=>{
      const owner=authorize(context);if(!owner)return {code:'OWNER_REQUIRED'};
      if(!limited(owner)){context.set.status=429;return {code:'MAIL_RATE_LIMIT'};}
      const config=await reportMailConfiguration(env);if(!config.vault||!config.provider){context.set.status=503;return {code:'MAIL_NOT_CONFIGURED'};}
      return requestReportVerification({db,ownerId:owner,vault:config.vault,provider:config.provider});
    },{body:t.Object({},{additionalProperties:false})})
    .post('/life/reports/mail/verify',async context=>{
      const owner=authorize(context);if(!owner)return {code:'OWNER_REQUIRED'};
      if(!limited(owner)){context.set.status=429;return {code:'MAIL_RATE_LIMIT'};}
      const config=await reportMailConfiguration(env);if(!config.vault){context.set.status=503;return {code:'MAIL_NOT_CONFIGURED'};}
      const result=await verifyReportRecipient({db,ownerId:owner,vault:config.vault,token:context.body.token});if(!result.verified)context.set.status=409;return result;
    },{body:t.Object({token:t.String({pattern:'^[A-Za-z0-9_-]{43}$'})},{additionalProperties:false})})
    .post('/life/reports/mail/enabled',async context=>{
      const owner=authorize(context);if(!owner)return {code:'OWNER_REQUIRED'};
      if(context.body.enabled&&!limited(owner)){context.set.status=429;return {code:'MAIL_RATE_LIMIT'};}
      // Emergency pause does not require a decryptable vault or available sender.
      if(context.body.enabled&&!(await reportMailConfiguration(env)).provider){context.set.status=503;return {code:'MAIL_NOT_CONFIGURED'};}
      const result=await setReportEmailEnabled({db,ownerId:owner,...context.body});if(!result.saved)context.set.status=result.reason==='write-budget'?503:409;return result;
    },{body:t.Object({enabled:t.Boolean(),contactRevision:revision,baseRevision:revision},{additionalProperties:false})})
    .get('/life/reports/mail/deliveries',async context=>{
      const owner=authorize(context);if(!owner)return {code:'OWNER_REQUIRED'};
      const rows=await db.prepare(`SELECT kind,state,error_code,created_at,updated_at FROM life_report_mail_deliveries WHERE owner_id=? ORDER BY created_at DESC,delivery_key DESC LIMIT 20`).bind(owner).all();
      if(!rows.success)throw Error();return {ownerId:owner,items:rows.results.map(row=>({...row,state:row.state==='submitting'&&Date.now()/1000-Number(row.updated_at)>=60?'unknown':row.state}))};
    });
}
