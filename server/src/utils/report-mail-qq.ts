/// <reference path="./report-mail-sockets.d.ts" />
import {reportRecipient} from './report-mail-vault';
import {reportMailMessage,type ReportMailProvider} from './report-mail-delivery';

type SMTPSocket={readable:ReadableStream<Uint8Array>;writable:WritableStream<Uint8Array>;opened:Promise<unknown>;closed:Promise<void>;close:()=>Promise<void>};
export type QQSMTPConnect=(address:{hostname:string;port:number},options:{secureTransport:'on';allowHalfOpen:false})=>SMTPSocket;
type Options={identity:string;from:string;to:string;authorizationCode:string;disallowedSecrets?:readonly string[];connect?:QQSMTPConnect;timeoutMs?:number};
const bytes=(s:string)=>new TextEncoder().encode(s);
const base64=(s:string)=>btoa(String.fromCharCode(...bytes(s)));

/** RFC 2047 words stay below 75 bytes, without splitting a UTF-8 character. */
function subjectHeader(subject:string){
  const words:string[]=[];let part='';
  for(const char of subject){if(bytes(part+char).length>42){words.push('=?UTF-8?B?'+base64(part)+'?=');part='';}part+=char;}
  if(part)words.push('=?UTF-8?B?'+base64(part)+'?=');return words.join('\r\n ');
}

/** One recipient, fixed TLS submission server, no URL/port overrides, no POP or
 * IMAP access. A successful final 250 means submission acceptance, NOT delivery.
 * The durable caller must acquire its claim and quota before calling submit. */
export function reportQQMailProvider(options:Options):ReportMailProvider{
  const from=reportRecipient(options.from),to=reportRecipient(options.to),secret=options.authorizationCode;
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(options.identity)||!/@qq\.com$/.test(from)||! /^[A-Za-z]{16}$/.test(secret)||(options.disallowedSecrets??[]).some(v=>v&&v===secret))throw Error('Invalid QQ mail configuration');
  return {identity:options.identity,async submit(value,signal){
    if(signal.aborted)return {state:'unknown'};
    let wire:string;
    try{
      if(reportRecipient(value.to)!==to||! /^[a-f0-9]{64}$/.test(value.deliveryKey))return {state:'rejected'};
      const message=reportMailMessage(value),body=base64(message.text).match(/.{1,76}/g)?.join('\r\n')??'';
      wire=[`From: ${from}`,`To: ${to}`,`Subject: ${subjectHeader(message.subject)}`,`Message-ID: <life-report.${value.deliveryKey}@qq.com>`,`Date: ${new Date().toUTCString()}`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',body,''].join('\r\n');
      if(bytes(wire).length>32768)return {state:'rejected'};
    }catch{return {state:'rejected'};}
    let socket:SMTPSocket|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,writer:WritableStreamDefaultWriter<Uint8Array>|undefined;
    let stopped=false;
    const close=()=>{stopped=true;if(socket){void socket.close().catch(()=>{});if(reader)void reader.cancel().catch(()=>{});if(writer)void writer.abort().catch(()=>{});}};
    const timeout=Math.max(1,Math.min(options.timeoutMs??12000,12000));
    let timer:ReturnType<typeof setTimeout>;
    let interrupt:()=>void=()=>{};
    const deadline=new Promise<never>((_,reject)=>{interrupt=()=>{close();reject(Error('Mail deadline'));};timer=setTimeout(interrupt,timeout);});
    signal.addEventListener('abort',interrupt,{once:true});
    const run=async()=>{
      const connect=options.connect??(await import('cloudflare:sockets')).connect as QQSMTPConnect;
      if(stopped||signal.aborted)throw Error();
      socket=connect({hostname:'smtp.qq.com',port:465},{secureTransport:'on',allowHalfOpen:false});
      // Runtime errors are handled without exposing server text or credentials.
      void socket.closed.catch(()=>{});
      await socket.opened;if(stopped||signal.aborted)throw Error();
      reader=socket.readable.getReader();writer=socket.writable.getWriter();
      const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',total=0;
      const reply=async()=>{
        let code:number|undefined;const lines:string[]=[];
        for(;;){
          if(stopped||signal.aborted)throw Error();
          const end=pending.indexOf('\r\n');
          if(end<0){
            if(pending.length>511||(pending.length===511&&!pending.endsWith('\r'))||/[\n\u0000]/.test(pending))throw Error();
            const part=await reader!.read();if(part.done)throw Error();total+=part.value.byteLength;if(total>32768)throw Error();
            pending+=decoder.decode(part.value,{stream:true});continue;
          }
          const line=pending.slice(0,end);pending=pending.slice(end+2);
          if(bytes(line).length>510||/[\r\n\u0000]/.test(line))throw Error();
          const match=/^([2-5][0-9]{2})([ -])(.*)$/.exec(line);if(!match)throw Error();
          const next=Number(match[1]);if(code!==undefined&&code!==next)throw Error();code=next;
          lines.push(match[3]);if(lines.length>64)throw Error();
          if(match[2]===' '){if(pending.length)throw Error();return {code,lines};}
        }
      };
      const expect=async(code:number)=>{const response=await reply();if(response.code===code)return response;if(response.code>=400)return null;throw Error();};
      const write=async(text:string)=>{if(stopped||signal.aborted)throw Error();await writer!.write(bytes(text));if(stopped||signal.aborted)throw Error();};
      if(!await expect(220))return {state:'rejected'} as const;
      await write('EHLO shjdness.github.io\r\n');const ehlo=await expect(250);if(!ehlo)return {state:'rejected'} as const;
      if(!ehlo.lines.some(line=>/^AUTH(?:=| )/i.test(line)&&line.replace(/^AUTH[= ]/i,'').split(/\s+/).some(v=>v.toUpperCase()==='LOGIN')))return {state:'rejected'} as const;
      await write('AUTH LOGIN\r\n');if(!await expect(334))return {state:'rejected'} as const;
      await write(btoa(from)+'\r\n');if(!await expect(334))return {state:'rejected'} as const;
      await write(btoa(secret)+'\r\n');if(!await expect(235))return {state:'rejected'} as const;
      await write(`MAIL FROM:<${from}>\r\n`);if(!await expect(250))return {state:'rejected'} as const;
      await write(`RCPT TO:<${to}>\r\n`);const recipient=await reply();if(![250,251].includes(recipient.code)){if(recipient.code>=400)return {state:'rejected'} as const;throw Error();}
      await write('DATA\r\n');if(!await expect(354))return {state:'rejected'} as const;
      // Base64 body cannot contain a dot-only line, so no untrusted SMTP commands
      // can escape the MIME content. Disconnect after DATA stays unknown.
      await write(wire+'.\r\n');const accepted=await expect(250);if(!accepted)return {state:'rejected'} as const;
      return {state:'accepted',id:'qq-'+value.deliveryKey} as const;
    };
    try{return await Promise.race([run(),deadline]);}
    catch{return {state:'unknown'};}
    finally{clearTimeout(timer!);signal.removeEventListener('abort',interrupt);close();}
  }};
}
