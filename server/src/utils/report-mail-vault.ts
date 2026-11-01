import {reportDigest} from './report-analysis-format';

const bytes=(value:string)=>new TextEncoder().encode(value);
const base64=(value:Uint8Array)=>btoa(String.fromCharCode(...value));
const decoded=(value:unknown)=>{
  if(typeof value!=='string'||value.length>2048||!value.length)throw Error('Invalid sealed recipient');
  const data=Uint8Array.from(atob(value),c=>c.charCodeAt(0));
  if(base64(data)!==value)throw Error('Invalid sealed recipient');return data;
};
const owner=(value:number)=>{if(!Number.isSafeInteger(value)||value<=0)throw Error('Recipient owner required');return value;};

/** Conservative mailbox syntax, no display-name lists, headers or control bytes.
 * Preserves the local part and normalizes only the case-insensitive domain. */
export function reportRecipient(value:string){
  if(typeof value!=='string'||value.length>254||/[\r\n\u0000-\u001f\u007f]/.test(value))throw Error('Invalid recipient');
  const email=value.trim(),parts=email.split('@');
  if(parts.length!==2||!parts[0].length||parts[0].length>64||!/[.]/.test(parts[1])||! /^[A-Za-z0-9._%+-]+$/.test(parts[0])||parts[0].startsWith('.')||parts[0].endsWith('.')||parts[0].includes('..'))throw Error('Invalid recipient');
  if(parts[1].split('.').some(label=>! /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))throw Error('Invalid recipient');
  return parts[0]+'@'+parts[1].toLowerCase();
}

export function maskedReportRecipient(email:string){const [local,domain]=reportRecipient(email).split('@');return local[0]+'***@'+domain;}

/** New-purpose random 32-byte base64 Secret. Never stored in D1, returned to the
 * browser, or borrowed from JWT/provider keys. HKDF separates AES/HMAC uses. */
export async function reportMailVault(secret:string,disallowed:readonly string[]=[]){
  if(typeof secret!=='string'||disallowed.some(value=>value&&value.trim()===secret.trim())||! /^[A-Za-z0-9+/]{43}=$/.test(secret.trim()))throw Error('Independent mail encryption Secret required');
  let raw:Uint8Array;
  try{raw=decoded(secret.trim());}catch{throw Error('Independent mail encryption Secret required');}
  if(raw.length!==32||new Set(raw).size<2)throw Error('Independent mail encryption Secret required');
  const material=await crypto.subtle.importKey('raw',new Uint8Array(raw),'HKDF',false,['deriveKey']);
  const params=(purpose:string)=>({name:'HKDF',hash:'SHA-256',salt:bytes('summer-radio:life-report-mail:v1'),info:bytes(purpose)});
  const encryption=await crypto.subtle.deriveKey(params('recipient/AES-256-GCM'),material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const authentication=await crypto.subtle.deriveKey(params('recipient-fingerprint/HMAC-SHA-256'),material,{name:'HMAC',hash:'SHA-256',length:256},false,['sign']);
  const aad=(ownerId:number)=>bytes(`life-report-recipient:v1:${owner(ownerId)}`);
  return {
    async seal(ownerId:number,value:string){
      const email=reportRecipient(value),iv=crypto.getRandomValues(new Uint8Array(12));
      const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(ownerId)},encryption,bytes(email));
      return JSON.stringify({version:1,iv:base64(iv),ciphertext:base64(new Uint8Array(ciphertext))});
    },
    async open(ownerId:number,sealed:string){
      try{
        if(typeof sealed!=='string'||sealed.length>2048)throw Error();
        const envelope=JSON.parse(sealed);if(envelope?.version!==1)throw Error();
        const iv=decoded(envelope.iv),ciphertext=decoded(envelope.ciphertext);
        if(iv.length!==12||ciphertext.length<17||ciphertext.length>270)throw Error();
        const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(iv),additionalData:aad(ownerId)},encryption,new Uint8Array(ciphertext));
        return reportRecipient(new TextDecoder('utf-8',{fatal:true}).decode(plaintext));
      }catch{throw Error('Recipient cannot be decrypted');}
    },
    async fingerprint(ownerId:number,value:string){
      const digest=await crypto.subtle.sign('HMAC',authentication,bytes(`life-report-recipient:v1:${owner(ownerId)}:${reportRecipient(value)}`));
      return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    },
  };
}

export async function reportVerificationToken(){
  const token=base64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  return {token,hash:await reportVerificationHash(token)};
}

export async function reportVerificationHash(token:string){
  if(typeof token!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(token))throw Error('Invalid verification token');
  return reportDigest('life-report-email-verification:v1:'+token);
}
