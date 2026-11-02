import {reportRecipient} from './report-mail-vault';
import {reportMailMessage,type ReportMailProvider} from './report-mail-delivery';
import {brevoMessageId} from './report-mail-brevo';

type MailProviderOptions={kind:'resend'|'brevo';identity:string;apiKey:string;from:string;disallowedSecrets?:readonly string[];fetcher?:(url:string,init:RequestInit)=>Promise<Response>};

/** Fixed official HTTPS destinations only. No runtime endpoint/redirect, SDK
 * retries, remote error text, recipient logs, tracking or attachments. This
 * transport does not supply consent or a durable claim: callers MUST use the
 * ledger flow. Creating it does not call the network or enable delivery. */
export function reportMailProvider(options:MailProviderOptions):ReportMailProvider{
  const {kind,identity,apiKey}=options,from=reportRecipient(options.from);
  if(!['resend','brevo'].includes(kind)||!/^[A-Za-z0-9_-]{1,64}$/.test(identity)||typeof apiKey!=='string'||apiKey.length<16||apiKey.length>1024||/[^\x21-\x7e]/.test(apiKey)||(options.disallowedSecrets??[]).some(value=>value&&value===apiKey))throw Error('Invalid mail provider configuration');
  const fetcher=options.fetcher??fetch;
  return {identity,async submit(value,signal){
    try{
      if(signal.aborted)return {state:'unknown'};
      const message=reportMailMessage(value),to=reportRecipient(value.to),key=value.deliveryKey;
      if(!/^[a-f0-9]{64}$/.test(key))return {state:'rejected'};
      const endpoint=kind==='resend'?'https://api.resend.com/emails':'https://api.brevo.com/v3/smtp/email';
      const headers:Record<string,string>={'Content-Type':'application/json','Accept':'application/json'};
      let body:unknown;
      if(kind==='resend'){
        headers.Authorization='Bearer '+apiKey;headers['Idempotency-Key']='life-report-'+key;
        body={from,to:[to],subject:message.subject,text:message.text,html:message.html,tags:[{name:'report_delivery',value:key}]};
      }else{
        headers['api-key']=apiKey;
        // Brevo asks for one content source. Plain text also avoids click/open
        // tracking markup and external images in the verification/report email.
        body={sender:{email:from,name:'夏令时电波'},to:[{email:to}],subject:message.subject,textContent:message.text,tags:['report_delivery_'+key]};
      }
      const response=await fetcher(endpoint,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal});
      // A 5xx, malformed success or connection loss may follow acceptance.
      // Never treat it as proof of non-delivery or retry automatically.
      if(!response.ok){void response.body?.cancel().catch(()=>{});return {state:response.status>=400&&response.status<500&&![408,409].includes(response.status)?'rejected':'unknown'};}
      const reader=response.body?.getReader();if(!reader)return {state:'unknown'};
      let size=0;const chunks:Uint8Array[]=[];
      const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
      try{
        if(signal.aborted)throw Error();
        for(;;){const part=await reader.read();if(signal.aborted)throw Error();if(part.done)break;size+=part.value.byteLength;if(size>8192)throw Error();chunks.push(part.value);}
        const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),id=kind==='resend'?data?.id:brevoMessageId(data?.messageId);
        return typeof id==='string'&&id.length>0&&id.length<=256&&!/[\u0000-\u0020\u007f]/.test(id)?{state:'accepted',id}:{state:'unknown'};
      }finally{signal.removeEventListener('abort',cancel);void reader.cancel().catch(()=>{});reader.releaseLock();}
    }catch{return {state:'unknown'};}
  }};
}
