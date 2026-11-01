import {expect,it,vi} from 'vitest';
import {mailFixture} from './report-mail-fixture';
import {reportMailCallback,REPORT_MAIL_WEBHOOK_PATH} from './report-mail-callback';

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
  const worker=(await import('../_worker')).default;
  const response=await worker.fetch(new Request('https://api.example.invalid'+REPORT_MAIL_WEBHOOK_PATH,{method:'POST',body:'PRIVATE_FORGED'}),env);
  expect(response.status).toBe(400);expect(await response.text()).toBe('');expect(db.prepare).not.toHaveBeenCalled();
  expect((await reportMailCallback(new Request('https://api.example.invalid'+REPORT_MAIL_WEBHOOK_PATH),env)).status).toBe(405);
});

it('applies authenticated bounce suppression even with delivery globally off and no vault/API key',async()=>{
  const f=await mailFixture();try{
    await f.configure();await f.issueFixture();
    const row=f.sqlite.prepare('SELECT delivery_key FROM life_report_mail_deliveries').get();
    f.sqlite.prepare("INSERT INTO life_report_mail_budget(bucket,reserved) VALUES('fixture',1)").run();
    f.sqlite.prepare("INSERT INTO life_report_mail_admissions(request_key,owner_bucket,global_bucket,created_at) VALUES(?,'fixture','fixture',?)").run(row.delivery_key,Math.floor(Date.now()/1000));
    const env={DB:f.raw,REPORT_MAIL_PROVIDER:'resend',REPORT_MAIL_PROVIDER_ID:'mock-v1',REPORT_MAIL_WEBHOOK_SECRET:secret,REPORT_MAIL_ENABLED:'false'} as any;
    const body=JSON.stringify({type:'email.bounced',data:{email_id:'fixture-provider-id',tags:{report_delivery:row.delivery_key},to:['PRIVATE_RECIPIENT'],subject:'PRIVATE_SUBJECT'}});
    expect((await reportMailCallback(await signed(body),env)).status).toBe(204);
    expect(f.sqlite.prepare('SELECT paused_reason FROM life_report_mail_contacts').get().paused_reason).toBe('bounced');
    const before=f.sqlite.prepare('SELECT total_changes() AS n').get().n;
    expect((await reportMailCallback(await signed(body),env)).status).toBe(204);
    expect(f.sqlite.prepare('SELECT total_changes() AS n').get().n).toBe(before);
    expect(JSON.stringify(f.sqlite.prepare('SELECT * FROM life_report_mail_events').all())).not.toContain('PRIVATE_');
  }finally{f.sqlite.close();}
});
