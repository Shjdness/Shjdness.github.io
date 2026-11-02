import {webhookBody} from './report-mail-webhook';
import {reportDigest} from './report-analysis-format';
import type {ReportMailEvent} from './report-mail-events';

/** Brevo's send API returns <Message-ID>, while callbacks may omit brackets.
 * Only normalize that wrapper; do not lowercase or URL-concatenate the ID. */
export function brevoMessageId(value:unknown){
  if(typeof value!=='string'||!value.length||value.length>256||/[\u0000-\u0020\u007f]/.test(value))throw Error('Invalid provider message ID');
  const id=value.startsWith('<')&&value.endsWith('>')?value.slice(1,-1):value;
  if(!id.length||/[<>]/.test(id))throw Error('Invalid provider message ID');return id;
}

/** Brevo uses a shared Bearer header over TLS, NOT a raw-body signature. The
 * event is trusted only after authenticating that header. No URL credentials,
 * IP-only authentication, recipient/subject retention, tracking or DB access.
 * This parser is not wired to a production route/provider configuration yet. */
export async function verifyBrevoReportWebhook(options:{request:Request;secret:string;providerIdentity:string;disallowedSecrets?:readonly string[];now?:Date;bodyTimeoutMs?:number}):Promise<ReportMailEvent|null>{
  const {request,secret,providerIdentity}=options;
  try{
    if(request.method!=='POST'||!/^[A-Za-z0-9_-]{43,128}$/.test(secret)||!/^[A-Za-z0-9_-]{1,64}$/.test(providerIdentity)||(options.disallowedSecrets??[]).some(s=>s&&s===secret))throw Error();
    const authorization=request.headers.get('authorization')??'';
    if(authorization.length>256||!/^Bearer [A-Za-z0-9_-]{43,128}$/.test(authorization))throw Error();
    // Compare via HMAC verification, without character-by-character secret
    // comparison. This does not add a message signature to Brevo's protocol.
    const bytes=(s:string)=>new TextEncoder().encode(s),params={name:'HMAC',hash:'SHA-256'};
    const candidate=await crypto.subtle.importKey('raw',bytes(authorization.slice(7)),params,false,['sign']);
    const expected=await crypto.subtle.importKey('raw',bytes(secret),params,false,['verify']);
    const context=bytes('life-report-brevo-bearer:v1');
    const proof=await crypto.subtle.sign('HMAC',candidate,context);
    if(!await crypto.subtle.verify('HMAC',expected,proof,context))throw Error();
    const raw=await webhookBody(request,options.bodyTimeoutMs),event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
    if(!event||typeof event!=='object'||Array.isArray(event))throw Error();
    const statuses=new Map<string,ReportMailEvent['status']>([['request','accepted'],['delivered','delivered'],['hard_bounce','bounced'],['invalid_email','bounced'],['spam','complained'],['unsubscribed','complained'],['blocked','rejected'],['error','rejected']]);
    const status=statuses.get(event.event);if(!status)return null; // Soft/deferred/open/click are not a terminal failure or human read.
    const tags=Object.hasOwn(event,'tags')?event.tags:Object.hasOwn(event,'tag')&&typeof event.tag==='string'?[event.tag]:[];
    if(!Array.isArray(tags)||tags.length>20)return null;
    const keys=tags.filter((tag:unknown)=>typeof tag==='string'&&/^report_delivery_[a-f0-9]{64}$/.test(tag));
    if(keys.length!==1)return null;const deliveryKey=keys[0].slice(16);
    if(!Object.hasOwn(event,'message-id'))throw Error();const providerId=brevoMessageId(event['message-id']);
    const seconds=Math.floor((options.now??new Date()).getTime()/1000),at=Object.hasOwn(event,'ts_event')?event.ts_event:Object.hasOwn(event,'ts')?event.ts:undefined;
    // Provider retries can be delayed. Old authenticated events are safe to
    // replay through the monotone ledger; never reject a legitimate old opt-out.
    if(!Number.isSafeInteger(seconds)||!Number.isSafeInteger(at)||at<0||at>seconds+300)throw Error();
    const eventId=await reportDigest(JSON.stringify(['brevo-webhook:v1',providerIdentity,deliveryKey,providerId,event.event,at]));
    // complained is the existing durable recipient-feedback suppression bucket;
    // for Brevo it includes unsubscribe, not just a spam complaint.
    return {eventId,deliveryKey,providerId,providerIdentity,status};
  }catch{throw Error('Invalid mail webhook');}
}
