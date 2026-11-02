import 'reflect-metadata';
import {drizzle} from 'drizzle-orm/d1';
import {SignJWT} from 'jose';
import {expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import {runRequestContext} from '../utils/di';
import {mailFixture,seconds} from '../utils/report-mail-fixture';
import {reportMailConfiguration} from '../utils/report-mail-config';
import {ReportMailService} from './report-mail';

const vaultKey=btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+1)));
const sender={REPORT_MAIL_VAULT_KEY:vaultKey,REPORT_MAIL_ENABLED:'true',REPORT_MAIL_PROVIDER:'resend',REPORT_MAIL_PROVIDER_ID:'fixture-v1',REPORT_MAIL_API_KEY:'fixture-provider-secret-only',REPORT_MAIL_FROM:'sender@example.invalid',REPORT_MAIL_WEBHOOK_SECRET:'whsec_'+btoa('fixture-webhook-key-never-real')};
async function fixture(){
  const f=await mailFixture(),db=drizzle(f.raw,{schema});
  const env={DB:f.raw,JWT_SECRET:'fixture-owner-signing-key-with-32-characters',RIN_GITHUB_CLIENT_ID:'fixture',RIN_GITHUB_CLIENT_SECRET:'fixture'} as any;
  const service=runRequestContext(env,db,()=>ReportMailService());
  const request=async(id:number|undefined,path='',body?:unknown)=>{
    const headers:Record<string,string>={};
    if(id)headers.Authorization='Bearer '+await new SignJWT({id}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));
    if(body!==undefined)headers['Content-Type']='application/json';
    return runRequestContext(env,db,()=>service.handle(new Request('http://localhost/life/reports/mail'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)})));
  };return {...f,env,request};
}

it('fails closed on absent, reused, incomplete or unsupported provider secrets without external calls',async()=>{
  const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No real provider calls'));
  const f=await fixture();try{
    for(const patch of [{},{...sender,REPORT_OUTBOUND_PAUSED:'true'},{...sender,REPORT_MAIL_ENABLED:'false'},{...sender,REPORT_MAIL_WEBHOOK_SECRET:''},{...sender,REPORT_MAIL_PROVIDER:'brevo'},{...sender,REPORT_MAIL_API_KEY:f.env.JWT_SECRET},{...sender,REPORT_MAIL_VAULT_KEY:f.env.JWT_SECRET}]){
      const config=await reportMailConfiguration({...f.env,...patch});expect(config.deliveryConfigured).toBe(false);
    }
    const valid=await reportMailConfiguration({...f.env,...sender});expect(valid.storageConfigured).toBe(true);expect(valid.deliveryConfigured).toBe(true);
    const brevo={...f.env,...sender,REPORT_MAIL_PROVIDER:'brevo',REPORT_MAIL_WEBHOOK_SECRET:'synthetic_callback_key_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ'};
    expect((await reportMailConfiguration(brevo)).deliveryConfigured).toBe(true);
    expect((await reportMailConfiguration({...brevo,REPORT_MAIL_API_KEY:brevo.REPORT_MAIL_WEBHOOK_SECRET})).deliveryConfigured).toBe(false);
    expect((await reportMailConfiguration({...brevo,REPORT_OUTBOUND_PAUSED:'true'})).deliveryConfigured).toBe(false);
    const qq={...f.env,...sender,REPORT_MAIL_PROVIDER:'qq-smtp',REPORT_MAIL_FROM:'fixture_sender@qq.com',REPORT_MAIL_TO:'fixture@example.invalid',REPORT_QQ_SMTP_AUTH_CODE:'abcdefghijklmnop',REPORT_MAIL_WEBHOOK_SECRET:undefined,REPORT_MAIL_API_KEY:undefined};
    const qqConfig=await reportMailConfiguration(qq);expect(qqConfig.deliveryConfigured).toBe(true);expect(qqConfig.feedbackMode).toBe('manual');
    for(const patch of [{REPORT_OUTBOUND_PAUSED:'true'},{REPORT_MAIL_ENABLED:'false'},{REPORT_QQ_SMTP_AUTH_CODE:undefined},{REPORT_MAIL_TO:undefined},{REPORT_MAIL_FROM:'other@outside.invalid'},{JWT_SECRET:qq.REPORT_QQ_SMTP_AUTH_CODE}])expect((await reportMailConfiguration({...qq,...patch})).deliveryConfigured).toBe(false);
    expect((await reportMailConfiguration({...qq,REPORT_MAIL_FROM:'other@qq.com'})).provider?.identity).not.toBe(qqConfig.provider?.identity);
    expect((await reportMailConfiguration({...qq,REPORT_MAIL_TO:'other@example.invalid'})).provider?.identity).not.toBe(qqConfig.provider?.identity);
    Object.assign(f.env,qq);const qqState=await (await f.request(1)).text();expect(qqState).toContain('"feedbackMode":"manual"');
    for(const privateValue of [qq.REPORT_MAIL_FROM,qq.REPORT_MAIL_TO,qq.REPORT_QQ_SMTP_AUTH_CODE])expect(qqState).not.toContain(privateValue);
    expect(network).not.toHaveBeenCalled();
  }finally{f.sqlite.close();network.mockRestore();}
});

it('protects all mail routes, isolates owner reads and excludes private bindings/bodies from responses',async()=>{
  const f=await fixture();try{
    Object.assign(f.env,sender);await f.configure();
    const before=f.sqlite.prepare('SELECT total_changes() AS n').get().n;
    const requests=[['',undefined],['/deliveries',undefined],['/recipient',{email:'other@example.invalid',baseRevision:0}],['/verification',{}],['/verify',{token:'a'.repeat(43)}],['/enabled',{enabled:true,contactRevision:1,baseRevision:1}]] as const;
    for(const owner of [undefined,3])for(const [path,body] of requests){const response=await f.request(owner,path,body);expect(response.status).toBe(403);expect(response.headers.get('cache-control')).toContain('no-store');}
    expect(f.sqlite.prepare('SELECT total_changes() AS n').get().n).toBe(before);
    const own=await (await f.request(1)).text();expect(own).toContain('f***@example.invalid');expect(own).not.toContain('fixture@example.invalid');
    for(const secret of [f.env.JWT_SECRET,...Object.values(sender).filter(v=>v.includes('secret')||v===vaultKey)])expect(own).not.toContain(secret);
    expect(await (await f.request(2)).json()).toMatchObject({ownerId:2,maskedRecipient:null,verified:false,enabled:false});
    expect(await (await f.request(2,'/deliveries')).json()).toMatchObject({ownerId:2,items:[]});
    const invalid=await f.request(1,'/recipient',{email:'PRIVATE_INPUT_TO_NOT_ECHO',baseRevision:0,extra:'SECRET'});
    expect(invalid.status).toBe(400);expect(await invalid.text()).not.toContain('PRIVATE_INPUT_TO_NOT_ECHO');
    const syntax=await f.request(1,'/recipient',{email:'PRIVATE_BAD_MAILBOX',baseRevision:1});
    expect(syntax.status).toBe(400);expect(await syntax.text()).toBe('{"code":"INVALID_MAIL_RECIPIENT"}');
  }finally{f.sqlite.close();}
});

it('stores only encrypted recipient, verifies owner-bound proof and permits emergency pause without mail keys',async()=>{
  const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No real provider calls'));
  const f=await fixture();try{
    f.env.REPORT_MAIL_VAULT_KEY=vaultKey;
    const saved=await f.request(1,'/recipient',{email:'fixture@example.invalid',baseRevision:0});expect(saved.status).toBe(200);
    const token=await f.issueFixture(Math.max(seconds,Math.floor(Date.now()/1000))+1800);
    expect((await f.request(2,'/verify',{token})).status).toBe(409);
    const verified=await f.request(1,'/verify',{token});expect(await verified.json()).toEqual({ownerId:1,verified:true});
    expect((await f.request(1,'/enabled',{enabled:true,contactRevision:1,baseRevision:1})).status).toBe(503);
    Object.assign(f.env,sender);
    expect(await (await f.request(1,'/enabled',{enabled:true,contactRevision:1,baseRevision:1})).json()).toMatchObject({saved:true});
    f.env.REPORT_MAIL_VAULT_KEY=btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+40)));
    expect(await (await f.request(1)).json()).toMatchObject({storageConfigured:false,maskedRecipient:null,preferencesRevision:2,enabled:true});
    delete f.env.REPORT_MAIL_VAULT_KEY;delete f.env.REPORT_MAIL_API_KEY;
    expect(await (await f.request(1)).json()).toMatchObject({storageConfigured:false,maskedRecipient:null,contactRevision:1,preferencesRevision:2,enabled:true});
    f.sqlite.exec("UPDATE rss_write_budget SET reserved=2000 WHERE day LIKE 'reports:%'");
    expect(await (await f.request(1,'/enabled',{enabled:false,contactRevision:1,baseRevision:2})).json()).toMatchObject({saved:true});
    expect(f.sqlite.prepare('SELECT email_enabled FROM life_report_preferences WHERE owner_id=1').get().email_enabled).toBe(0);
    expect(JSON.stringify(f.sqlite.prepare('SELECT * FROM life_report_mail_contacts').all())).not.toContain('fixture@example.invalid');
    expect(network).not.toHaveBeenCalled();
  }finally{f.sqlite.close();network.mockRestore();}
});
