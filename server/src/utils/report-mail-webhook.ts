import {reportDigest} from './report-analysis-format';
import type {ReportMailEvent} from './report-mail-events';

const bytes=(value:string)=>new TextEncoder().encode(value);
const decode=(value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));

async function webhookBody(request:Request,timeoutMs=5000){
  if(Number(request.headers.get('content-length')??0)>32768)throw Error('Invalid mail webhook');
  const reader=request.body?.getReader();if(!reader)return new Uint8Array();
  const chunks:Uint8Array[]=[];let size=0,expired=false,timer:ReturnType<typeof setTimeout>;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>{});reject(Error('Invalid mail webhook'));},Math.max(1,Math.min(timeoutMs,5000)));});
  try{
    return await Promise.race([(async()=>{
      for(;;){const part=await reader.read();if(expired)throw Error('Invalid mail webhook');if(part.done)break;size+=part.value.byteLength;if(size>32768)throw Error('Invalid mail webhook');chunks.push(part.value);}
      const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result;
    })(),deadline]);
  }finally{clearTimeout(timer!);void reader.cancel().catch(()=>{});reader.releaseLock();}
}

/** Resend/Svix raw-body HMAC verification. No database access, logging or network.
 * Keep native event IDs stable for replay protection; never stringify before MAC. */
export async function verifyResendReportWebhook(options:{request:Request;secret:string;providerIdentity:string;disallowedSecrets?:readonly string[];now?:Date;bodyTimeoutMs?:number}):Promise<ReportMailEvent|null>{
  const {request,secret,providerIdentity}=options,now=options.now??new Date();
  try{
    if(request.method!=='POST'||!secret.startsWith('whsec_')||(options.disallowedSecrets??[]).some(s=>s&&s===secret)||!/^[A-Za-z0-9_-]{1,64}$/.test(providerIdentity)||!Number.isFinite(now.getTime()))throw Error();
    const keyBytes=decode(secret.slice(6));if(keyBytes.length<16||keyBytes.length>64)throw Error();
    const id=request.headers.get('svix-id')??'',timestamp=request.headers.get('svix-timestamp')??'',signatures=request.headers.get('svix-signature')??'';
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)||!/^\d{1,12}$/.test(timestamp)||Math.abs(now.getTime()/1000-Number(timestamp))>300||!signatures||signatures.length>2048)throw Error();
    const raw=await webhookBody(request,options.bodyTimeoutMs),prefix=bytes(id+'.'+timestamp+'.'),signed=new Uint8Array(prefix.length+raw.length);signed.set(prefix);signed.set(raw,prefix.length);
    const key=await crypto.subtle.importKey('raw',new Uint8Array(keyBytes),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    let valid=false;
    for(const signature of signatures.split(/\s+/).slice(0,5)){
      const [version,value]=signature.split(',');if(version!=='v1'||!value)continue;
      try{const digest=decode(value);if(digest.length===32&&await crypto.subtle.verify('HMAC',key,new Uint8Array(digest),signed))valid=true;}catch{/* malformed rotation candidate is not a valid signature */}
    }
    if(!valid)throw Error();
    const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
    const statuses=new Map<string,ReportMailEvent['status']>([['email.sent','accepted'],['email.delivered','delivered'],['email.failed','rejected'],['email.bounced','bounced'],['email.complained','complained']]);
    const status=statuses.get(payload?.type);
    if(!status)return null; // Open/click events deliberately do not imply a human read.
    const data=payload.data;if(!data||typeof data!=='object'||Array.isArray(data))throw Error();
    const tags=Object.hasOwn(data,'tags')?data.tags:undefined;
    let candidates:unknown[]=[];
    if(Array.isArray(tags)&&tags.length<=20)candidates=tags.filter(t=>t?.name==='report_delivery').map(t=>t.value);
    else if(tags&&typeof tags==='object'&&Object.keys(tags).length<=20&&Object.hasOwn(tags,'report_delivery'))candidates=[tags.report_delivery];
    if(candidates.length!==1||typeof candidates[0]!=='string'||!/^[a-f0-9]{64}$/.test(candidates[0]))return null;
    if(!Object.hasOwn(data,'email_id')||typeof data.email_id!=='string'||!data.email_id.length||data.email_id.length>256||/[\u0000-\u0020\u007f]/.test(data.email_id))throw Error();
    return {eventId:await reportDigest(`resend-webhook:v1:${providerIdentity}:${id}`),deliveryKey:candidates[0],providerId:data.email_id,providerIdentity,status};
  }catch{throw Error('Invalid mail webhook');}
}
