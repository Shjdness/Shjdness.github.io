import {expect,it} from 'vitest';
import {brevoMessageId,verifyBrevoReportWebhook} from './report-mail-brevo';
const secret='synthetic_callback_key_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const now=new Date('2026-11-02T00:00:00Z'),at=now.getTime()/1000;
const payload={event:'delivered','message-id':'<fixture@relay.example.invalid>',ts_event:at,tags:['report_delivery_'+'a'.repeat(64)],email:'PRIVATE_RECIPIENT',subject:'PRIVATE_SUBJECT',id:123};
const request=(value:unknown=payload,header='Bearer '+secret)=>new Request('https://api.example.invalid/brevo',{method:'POST',headers:{Authorization:header},body:JSON.stringify(value)});
it('authenticates the header before reading a private body and projects only normalized ledger metadata',async()=>{
  const event=await verifyBrevoReportWebhook({request:request(),secret,providerIdentity:'fixture',now});
  expect(event).toMatchObject({providerId:'fixture@relay.example.invalid',deliveryKey:'a'.repeat(64),status:'delivered'});expect(JSON.stringify(event)).not.toContain('PRIVATE_');
  expect(await verifyBrevoReportWebhook({request:request({...payload,'message-id':'fixture@relay.example.invalid',id:999}),secret,providerIdentity:'fixture',now})).toEqual(event);
  const invalid=request(payload,'Bearer '+'x'.repeat(50));await expect(verifyBrevoReportWebhook({request:invalid,secret,providerIdentity:'fixture',now})).rejects.toThrow('Invalid mail webhook');expect(invalid.bodyUsed).toBe(false);
});
it('retains old authenticated suppressions, distinguishes feedback and ignores transient/tracking events',async()=>{
  const base={secret,providerIdentity:'fixture',now};
  for(const [kind,state] of [['request','accepted'],['hard_bounce','bounced'],['spam','complained'],['unsubscribed','complained']])expect(await verifyBrevoReportWebhook({...base,request:request({...payload,event:kind,ts_event:at-864000,tags:undefined,tag:payload.tags[0]})})).toMatchObject({status:state});
  for(const kind of ['soft_bounce','deferred','click','opened','unique_opened','__proto__'])expect(await verifyBrevoReportWebhook({...base,request:request({...payload,event:kind})})).toBeNull();
  await expect(verifyBrevoReportWebhook({...base,request:request({...payload,ts_event:at+301})})).rejects.toThrow('Invalid mail webhook');
});
it('bounds body/time/secret inputs and rejects ambiguous tags or malformed message IDs',async()=>{
  const base={secret,providerIdentity:'fixture',now};
  await expect(verifyBrevoReportWebhook({...base,request:request({...payload,subject:'x'.repeat(32769)})})).rejects.toThrow('Invalid mail webhook');
  await expect(verifyBrevoReportWebhook({...base,disallowedSecrets:[secret],request:request()})).rejects.toThrow('Invalid mail webhook');
  expect(await verifyBrevoReportWebhook({...base,request:request({...payload,tags:[...payload.tags,...payload.tags]})})).toBeNull();
  for(const id of ['<>','<missing','a\r\nInjected: true','a'.repeat(257)])expect(()=>brevoMessageId(id)).toThrow();
  const stalled=new Request('https://api.example.invalid/brevo',{method:'POST',headers:{Authorization:'Bearer '+secret},body:new ReadableStream({start(){}}),duplex:'half'} as RequestInit);
  await expect(verifyBrevoReportWebhook({...base,request:stalled,bodyTimeoutMs:5})).rejects.toThrow('Invalid mail webhook');
});
