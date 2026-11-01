import {expect,it} from 'vitest';
import {verifyResendReportWebhook} from './report-mail-webhook';
const secret='whsec_'+btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+1)));
const now=new Date('2026-11-02T00:00:00Z'),timestamp=String(now.getTime()/1000),id='msg_fixture_1';
const payload={type:'email.delivered',data:{email_id:'fixture-provider-id',from:'private-sender@example.invalid',to:['private-recipient@example.invalid'],subject:'Private fixture',tags:{report_delivery:'a'.repeat(64)}}};
async function signed(body=JSON.stringify(payload),at=timestamp){
  const key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(secret.slice(6)),c=>c.charCodeAt(0)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(id+'.'+at+'.'+body));
  return {body,headers:{'svix-id':id,'svix-timestamp':at,'svix-signature':'v1,'+btoa(String.fromCharCode(...new Uint8Array(digest)))}};
}
const request=(value:{body:string;headers:Record<string,string>})=>new Request('https://api.example.invalid/report-webhook',{method:'POST',...value});

it('matches the published Svix reference vector and authenticates exact raw bytes before projecting only delivery metadata',async()=>{
  const vector=new Request('https://api.example.invalid/report-webhook',{method:'POST',body:'{"event_type":"ping","data":{"success":true}}',headers:{'svix-id':'msg_loFOjxBNrRLzqYUf','svix-timestamp':'1731705121','svix-signature':'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0='}});
  expect(await verifyResendReportWebhook({request:vector,secret:'whsec_plJ3nmyCDGBKInavdOK15jsl',providerIdentity:'fixture',now:new Date(1731705121000)})).toBeNull();
  const options={request:request(await signed()),secret,providerIdentity:'fixture',now};
  const event=await verifyResendReportWebhook(options);
  expect(event).toMatchObject({status:'delivered',deliveryKey:'a'.repeat(64),providerId:'fixture-provider-id'});
  expect(JSON.stringify(event)).not.toMatch(/private|Private|example.invalid/);
  expect(await verifyResendReportWebhook({...options,request:request(await signed())})).toEqual(event);
});

it('rejects stale/future signatures, body changes, malformed signatures and oversized bodies',async()=>{
  const normal=await signed();
  const candidates=[{...normal,body:normal.body+' '},await signed(JSON.stringify(payload),String(Number(timestamp)-301)),await signed(JSON.stringify(payload),String(Number(timestamp)+301)),{...normal,headers:{...normal.headers,'svix-signature':'v1,invalid'}},await signed('x'.repeat(32769))];
  for(const input of candidates)await expect(verifyResendReportWebhook({request:request(input),secret,providerIdentity:'fixture',now})).rejects.toThrow('Invalid mail webhook');
});

it('supports key-rotation signature lists and ignores unrelated/open/click events rather than claiming a human read',async()=>{
  const input=await signed();input.headers['svix-signature']='v2,ignore v1,invalid '+input.headers['svix-signature'];
  expect((await verifyResendReportWebhook({request:request(input),secret,providerIdentity:'fixture',now}))?.status).toBe('delivered');
  const arrayTags={...payload,data:{...payload.data,tags:[{name:'report_delivery',value:'a'.repeat(64)}]}};
  expect((await verifyResendReportWebhook({request:request(await signed(JSON.stringify(arrayTags))),secret,providerIdentity:'fixture',now}))?.deliveryKey).toBe('a'.repeat(64));
  for(const body of [{...payload,type:'email.opened'},{...payload,type:'__proto__'},{...payload,data:{...payload.data,tags:{unrelated:'value'}}}])expect(await verifyResendReportWebhook({request:request(await signed(JSON.stringify(body))),secret,providerIdentity:'fixture',now})).toBeNull();
});


it('stops stalled raw bodies within a whole-body deadline before parsing or database work',async()=>{
  const normal=await signed();
  const stalled=new Request('https://api.example.invalid/report-webhook',{method:'POST',headers:normal.headers,body:new ReadableStream({start(){}}),duplex:'half'} as RequestInit);
  await expect(verifyResendReportWebhook({request:stalled,secret,providerIdentity:'fixture',now,bodyTimeoutMs:10})).rejects.toThrow('Invalid mail webhook');
});
