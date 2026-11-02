import {expect,it,vi} from 'vitest';
import {mailFixture} from './report-mail-fixture';
import {reportMailCallback,REPORT_MAIL_WEBHOOK_PATH,REPORT_MAIL_BREVO_WEBHOOK_PATH} from './report-mail-callback';
import worker from '../_worker';
import {reportMailProvider} from './report-mail-provider';
import {requestReportVerification} from './report-mail-delivery';
import {verifyReportRecipient,setReportEmailEnabled} from './report-mail-contacts';

const secret='whsec_'+btoa('isolated-webhook-key-not-a-real-secret');
async function signed(body:string){
  const id='fixture_event',timestamp=String(Math.floor(Date.now()/1000));
  const key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(secret.slice(6)),c=>c.charCodeAt(0)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(id+'.'+timestamp+'.'+body));
  return new Request('https://api.example.invalid'+REPORT_MAIL_WEBHOOK_PATH,{method:'POST',body,headers:{'svix-id':id,'svix-timestamp':timestamp,'svix-signature':'v1,'+btoa(String.fromCharCode(...new Uint8Array(signature)))}});
}

it('rejects forged callbacks in the Worker before any D1/config initialization',async()=>{
  const db={prepare:vi.fn(()=>{throw Error('Unexpected D1 access');})};
  const env={DB:db,REPORT_MAIL_PROVIDER:'resend',REPORT_MAIL_PROVIDER_ID:'mock-v1',REPORT_MAIL_WEBHOOK_SECRET:secret} as any;
  const response=await worker.fetch(new Request('https://api.example.invalid'+REPORT_MAIL_WEBHOOK_PATH,{method:'POST',body:'PRIVATE_FORGED'}),env);
  expect(response.status).toBe(400);expect(await response.text()).toBe('');expect(db.prepare).not.toHaveBeenCalled();
  expect((await reportMailCallback(new Request('https://api.example.invalid'+REPORT_MAIL_WEBHOOK_PATH),env)).status).toBe(405);
});

it('binds a real simulated Brevo submission, canonical IDs and recipient opt-out to the shared durable ledger',async()=>{
  const f=await mailFixture();try{
    await f.configure();let outboundText='';
    const provider=reportMailProvider({kind:'brevo',identity:'mock-v1',apiKey:'synthetic-provider-key',from:'sender@example.invalid',fetcher:async(_url,init)=>{outboundText=JSON.parse(String(init.body)).textContent;return Response.json({messageId:'<fixture@relay.example.invalid>'});}});
    expect(await requestReportVerification({db:f.raw,ownerId:1,vault:f.vault,provider})).toMatchObject({state:'accepted'});
    const proof=outboundText.match(/verify=([A-Za-z0-9_-]{43})/)![1];
    expect(await verifyReportRecipient({db:f.raw,ownerId:1,vault:f.vault,token:proof})).toMatchObject({verified:true});
    await setReportEmailEnabled({db:f.raw,ownerId:1,enabled:true,contactRevision:1,baseRevision:1});
    const delivery=f.sqlite.prepare('SELECT delivery_key,provider_id FROM life_report_mail_deliveries').get();expect(delivery.provider_id).toBe('fixture@relay.example.invalid');
    // Simulate an accepted submission whose response/ID was lost locally.
    // The durable admission remains; an authenticated callback can reconcile it.
    f.sqlite.exec("UPDATE life_report_mail_deliveries SET state='unknown',provider_id=NULL");
    const bearer='synthetic_callback_key_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const env={DB:f.raw,REPORT_MAIL_PROVIDER:'brevo',REPORT_MAIL_PROVIDER_ID:'mock-v1',REPORT_MAIL_WEBHOOK_SECRET:bearer,REPORT_MAIL_ENABLED:'false',REPORT_OUTBOUND_PAUSED:'true'} as any;
    const make=(event:string,auth='Bearer '+bearer,path=REPORT_MAIL_BREVO_WEBHOOK_PATH)=>new Request('https://api.example.invalid'+path,{method:'POST',headers:{Authorization:auth},body:JSON.stringify({event,'message-id':'<fixture@relay.example.invalid>',ts_event:Math.floor(Date.now()/1000),tags:['report_delivery_'+delivery.delivery_key],email:'PRIVATE_EMAIL',subject:'PRIVATE_SUBJECT'})});
    const reads=vi.spyOn(f.raw,'prepare');
    expect((await worker.fetch(make('delivered','Bearer '+'x'.repeat(50)),env)).status).toBe(400);expect(reads).not.toHaveBeenCalled();
    expect((await worker.fetch(make('delivered',undefined,REPORT_MAIL_WEBHOOK_PATH),env)).status).toBe(404);expect(reads).not.toHaveBeenCalled();
    expect((await worker.fetch(make('delivered'),env)).status).toBe(204);
    expect(f.sqlite.prepare('SELECT state FROM life_report_mail_deliveries').get().state).toBe('delivered');
    expect(f.sqlite.prepare('SELECT provider_id FROM life_report_mail_deliveries').get().provider_id).toBe('fixture@relay.example.invalid');
    const unsubscribe=make('unsubscribed');
    expect((await worker.fetch(unsubscribe.clone(),env)).status).toBe(204);
    expect(f.sqlite.prepare('SELECT paused_reason FROM life_report_mail_contacts').get().paused_reason).toBe('complained');
    expect(f.sqlite.prepare('SELECT email_enabled FROM life_report_preferences').get().email_enabled).toBe(0);
    const before=f.sqlite.prepare('SELECT total_changes() AS n').get().n;
    expect((await worker.fetch(unsubscribe.clone(),env)).status).toBe(204);
    expect((await worker.fetch(make('delivered'),env)).status).toBe(204);
    expect(f.sqlite.prepare('SELECT total_changes() AS n').get().n).toBe(before);
    expect(JSON.stringify(f.sqlite.prepare('SELECT * FROM life_report_mail_events').all())).not.toContain('PRIVATE_');
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_mail_admissions').get().n).toBe(1);
  }finally{f.sqlite.close();}
});

it('applies authenticated bounce suppression even with delivery globally off and no vault/API key',async()=>{
  const f=await mailFixture();try{
    await f.configure();await f.issueFixture();
    const row=f.sqlite.prepare('SELECT delivery_key FROM life_report_mail_deliveries').get();
    f.sqlite.prepare("INSERT INTO life_report_mail_budget(bucket,reserved) VALUES('fixture',1)").run();
    f.sqlite.prepare("INSERT INTO life_report_mail_admissions(request_key,owner_bucket,global_bucket,created_at) VALUES(?,'fixture','fixture',?)").run(row.delivery_key,Math.floor(Date.now()/1000));
    const env={DB:f.raw,REPORT_MAIL_PROVIDER:'resend',REPORT_MAIL_PROVIDER_ID:'mock-v1',REPORT_MAIL_WEBHOOK_SECRET:secret,REPORT_MAIL_ENABLED:'false',REPORT_OUTBOUND_PAUSED:'true'} as any;
    const body=JSON.stringify({type:'email.bounced',data:{email_id:'fixture-provider-id',tags:{report_delivery:row.delivery_key},to:['PRIVATE_RECIPIENT'],subject:'PRIVATE_SUBJECT'}});
    expect((await reportMailCallback(await signed(body),env)).status).toBe(204);
    expect(f.sqlite.prepare('SELECT paused_reason FROM life_report_mail_contacts').get().paused_reason).toBe('bounced');
    const before=f.sqlite.prepare('SELECT total_changes() AS n').get().n;
    expect((await reportMailCallback(await signed(body),env)).status).toBe(204);
    expect(f.sqlite.prepare('SELECT total_changes() AS n').get().n).toBe(before);
    expect(JSON.stringify(f.sqlite.prepare('SELECT * FROM life_report_mail_events').all())).not.toContain('PRIVATE_');
  }finally{f.sqlite.close();}
});
