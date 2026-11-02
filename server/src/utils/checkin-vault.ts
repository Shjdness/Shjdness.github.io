import {checkinValue,type Checkin,checkinDate} from './checkin-format';
const bytes=(s:string)=>new TextEncoder().encode(s);
const b64=(v:Uint8Array)=>btoa(String.fromCharCode(...v));
const un64=(v:string)=>Uint8Array.from(atob(v),c=>c.charCodeAt(0));
/** New module key: never borrow JWT, mail vault or provider credentials. */
export async function checkinVault(secret:string,disallowed:readonly string[]=[]){
  if(typeof secret!=='string'||! /^[A-Za-z0-9+/]{43}=$/.test(secret)||disallowed.some(v=>v&&v.trim()===secret))throw Error('Independent check-in key required');
  const raw=un64(secret);if(raw.length!==32||b64(raw)!==secret||new Set(raw).size<8)throw Error('Independent check-in key required');
  const material=await crypto.subtle.importKey('raw',raw,'HKDF',false,['deriveKey']);
  const params=(info:string)=>({name:'HKDF',hash:'SHA-256',salt:bytes('summer-radio:checkin:v1'),info:bytes(info)});
  const encryption=await crypto.subtle.deriveKey(params('AES-GCM'),material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const hmac=await crypto.subtle.deriveKey(params('fingerprint'),material,{name:'HMAC',hash:'SHA-256',length:256},false,['sign']);
  const aad=(owner:number,date:string,revision:number)=>{checkinDate(date);if(!Number.isSafeInteger(owner)||owner<=0||!Number.isSafeInteger(revision)||revision<1)throw Error('Invalid record identity');return bytes(`checkin:v1:${owner}:${date}:${revision}`);};
  const payloadIdentity=(owner:number,purpose:string,binding:string)=>{if(!Number.isSafeInteger(owner)||owner<=0||!['report-snapshot','report-analysis','report-mail'].includes(purpose)||!/^[a-f0-9]{64}$/.test(binding))throw Error('Invalid sealed payload binding');return bytes(`checkin-payload:v1:${owner}:${purpose}:${binding}`);};
  const payloadKey=(purpose:string)=>crypto.subtle.deriveKey(params('payload/'+purpose+'/AES-GCM'),material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const payloadJSON=(value:unknown)=>{const json=JSON.stringify(value);if(typeof json!=='string'||bytes(json).length>128000)throw Error('Payload too large');return json;};
  return {
    keyFingerprint:b64(new Uint8Array(await crypto.subtle.sign('HMAC',hmac,bytes('checkin:module-key-proof:v1')))),
    async digest(owner:number,date:string,value:Checkin){const data=await crypto.subtle.sign('HMAC',hmac,bytes(`${owner}:${checkinDate(date)}:${JSON.stringify(checkinValue(value,date))}`));return b64(new Uint8Array(data));},
    async seal(owner:number,date:string,revision:number,value:Checkin){const iv=crypto.getRandomValues(new Uint8Array(12));const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(owner,date,revision)},encryption,bytes(JSON.stringify(checkinValue(value,date))));return JSON.stringify({v:1,iv:b64(iv),cipher:b64(new Uint8Array(cipher))});},
    async open(owner:number,date:string,revision:number,sealed:string){try{if(sealed.length>24000)throw Error();const e=JSON.parse(sealed);if(e.v!==1||typeof e.iv!=='string'||typeof e.cipher!=='string')throw Error();const iv=un64(e.iv),cipher=un64(e.cipher);if(iv.length!==12||cipher.length<16||cipher.length>16016)throw Error();const data=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(owner,date,revision)},encryption,cipher);return checkinValue(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)),date);}catch{throw Error('Check-in decryption unavailable');}},
    async sealPayload(owner:number,purpose:'report-snapshot'|'report-analysis'|'report-mail',binding:string,value:unknown){const identity=payloadIdentity(owner,purpose,binding),iv=crypto.getRandomValues(new Uint8Array(12));const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:identity},await payloadKey(purpose),bytes(payloadJSON(value)));return JSON.stringify({v:1,iv:b64(iv),cipher:b64(new Uint8Array(cipher))});},
    async openPayload(owner:number,purpose:'report-snapshot'|'report-analysis'|'report-mail',binding:string,sealed:string):Promise<unknown>{try{if(typeof sealed!=='string'||sealed.length>180000)throw Error();const e=JSON.parse(sealed);if(e.v!==1||typeof e.iv!=='string'||typeof e.cipher!=='string')throw Error();const iv=un64(e.iv),cipher=un64(e.cipher);if(iv.length!==12||cipher.length<16||cipher.length>128016)throw Error();const data=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:payloadIdentity(owner,purpose,binding)},await payloadKey(purpose),cipher);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{throw Error('Sealed report unavailable');}},
    async payloadDigest(owner:number,purpose:'report-snapshot'|'report-analysis'|'report-mail',binding:string,value:unknown){const identity=new TextDecoder().decode(payloadIdentity(owner,purpose,binding));return b64(new Uint8Array(await crypto.subtle.sign('HMAC',hmac,bytes(identity+':'+payloadJSON(value)))));},
  };
}
export type CheckinVault=Awaited<ReturnType<typeof checkinVault>>;
