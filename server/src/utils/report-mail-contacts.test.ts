import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {requestReportVerification,submitReportDelivery,reserveMailSubmission,readReportDelivery,type ReportMailProvider} from './report-mail-delivery';
import {reportMailVault,reportVerificationToken} from './report-mail-vault';
import {saveReportRecipient,reportMailContactState,verifyReportRecipient,setReportEmailEnabled} from './report-mail-contacts';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
const now=new Date('2026-11-02T00:00:00Z'),seconds=now.getTime()/1000;
const secret=btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+1)));

async function fixture(){
  const sqlite=new DatabaseSync(':memory:'),folder=new URL('../../sql/',import.meta.url);
  for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort()){
    sqlite.exec(readFileSync(new URL(file,folder),'utf8'));if(file==='0002.sql')sqlite.exec('ALTER TABLE feeds ADD COLUMN top INTEGER DEFAULT 0');
  }
  sqlite.exec("INSERT INTO users(id,username,openid,permission) VALUES(1,'owner','owner',1),(2,'other','other',1),(3,'trusted','trusted',2); INSERT INTO life_report_preferences(owner_id,daily_time,daily_enabled,weekly_enabled) VALUES(1,'09:15',1,1)");
  let tail=Promise.resolve();
  const raw={prepare(sql:string){let values:unknown[]=[];return {bind(...args:unknown[]){values=args;return this;},async all(){return {success:true,results:sqlite.prepare(sql).all(...values),meta:{}};}};},batch(statements:Array<{all:()=>Promise<unknown>}>){
    const next=tail.then(async()=>{sqlite.exec('BEGIN');try{const rows=[];for(const statement of statements)rows.push(await statement.all());sqlite.exec('COMMIT');return rows;}catch(error){sqlite.exec('ROLLBACK');throw error;}});tail=next.then(()=>{},()=>{});return next;
  }} as any;
  const vault=await reportMailVault(secret);
  const configure=(email='fixture@example.invalid',baseRevision=0)=>saveReportRecipient({db:raw,ownerId:1,email,baseRevision,vault,now});
  const issueFixture=async(expires=seconds+1800)=>{
    const token=await reportVerificationToken(),contact=sqlite.prepare('SELECT * FROM life_report_mail_contacts WHERE owner_id=1').get(),key=token.hash;
    // Test-only fake outbound proof. No production issuer or provider is wired yet.
    sqlite.prepare("INSERT INTO life_report_mail_deliveries(delivery_key,owner_id,kind,purpose_key,contact_revision,fingerprint,provider_identity,state,message_sha256,created_at,updated_at) VALUES(?,1,'verification',?,?,?,'mock-v1','accepted',?,?,?)").run(key,key,contact.revision,contact.fingerprint,'a'.repeat(64),seconds,seconds);
    sqlite.prepare('INSERT INTO life_report_mail_verifications(token_hash,owner_id,contact_revision,fingerprint,delivery_key,created_at,expires_at) VALUES(?,1,?,?,?,?,?)').run(token.hash,contact.revision,contact.fingerprint,key,seconds-60,expires);
    return token.token;
  };
  return {sqlite,raw,vault,configure,issueFixture};
}

it('stores only account-bound ciphertext, avoids unchanged rewrites and rejects stale recipient edits',async()=>{
  const f=await fixture();try{
    expect(await f.configure()).toMatchObject({saved:true,contactRevision:1,maskedRecipient:'f***@example.invalid',verified:false,enabled:false});
    const original=f.sqlite.prepare('SELECT * FROM life_report_mail_contacts').get();expect(JSON.stringify(original)).not.toContain('fixture@example.invalid');
    const before=f.sqlite.prepare('SELECT total_changes() AS n').get().n;
    expect(await f.configure()).toMatchObject({saved:true,contactRevision:1});expect(f.sqlite.prepare('SELECT total_changes() AS n').get().n).toBe(before);
    expect(await f.configure('other@example.invalid',0)).toMatchObject({saved:false,contactRevision:1});
    expect(await reportMailContactState(f.raw,2,f.vault)).toMatchObject({maskedRecipient:null,contactRevision:0});
    await expect(saveReportRecipient({db:f.raw,ownerId:3,email:'fixture@example.invalid',baseRevision:0,vault:f.vault,now})).rejects.toThrow('Owner');
    expect(f.sqlite.prepare('SELECT daily_time,daily_enabled,weekly_enabled FROM life_report_preferences').get()).toMatchObject({daily_time:'09:15',daily_enabled:1,weekly_enabled:1});
  }finally{f.sqlite.close();}
});

it('redeems a token once under racing verification, then changing address disables delivery and invalidates old proofs',async()=>{
  const f=await fixture();try{
    await f.configure();const token=await f.issueFixture();
    expect(await verifyReportRecipient({db:f.raw,ownerId:2,token,vault:f.vault,now})).toEqual({verified:false});
    const verified=await Promise.all(Array.from({length:5},()=>verifyReportRecipient({db:f.raw,ownerId:1,token,vault:f.vault,now})));
    expect(verified.every(result=>result.verified)).toBe(true);
    expect(f.sqlite.prepare('SELECT used_at FROM life_report_mail_verifications').get()).toMatchObject({used_at:seconds});
    expect(await setReportEmailEnabled({db:f.raw,ownerId:1,enabled:true,contactRevision:1,baseRevision:1,now})).toMatchObject({saved:true});
    expect(await reportMailContactState(f.raw,1,f.vault)).toMatchObject({enabled:true,verified:true,preferencesRevision:2});
    expect(await f.configure('new@example.invalid',1)).toMatchObject({saved:true,contactRevision:2,verified:false,enabled:false});
    expect(await verifyReportRecipient({db:f.raw,ownerId:1,token,vault:f.vault,now})).toEqual({verified:false});
    expect(await setReportEmailEnabled({db:f.raw,ownerId:1,enabled:true,contactRevision:1,baseRevision:3,now})).toMatchObject({saved:false,reason:'verification-required'});
    expect(f.sqlite.prepare('SELECT daily_time,daily_enabled,weekly_enabled,email_enabled FROM life_report_preferences').get()).toMatchObject({daily_time:'09:15',daily_enabled:1,weekly_enabled:1,email_enabled:0});
  }finally{f.sqlite.close();}
});

it('rejects expired/unverified/suppressed activation and supports a manual pause without requiring decryption',async()=>{
  const f=await fixture();try{
    await f.configure();const expired=await f.issueFixture(seconds-1);
    expect(await verifyReportRecipient({db:f.raw,ownerId:1,token:expired,vault:f.vault,now})).toEqual({verified:false});
    expect(await setReportEmailEnabled({db:f.raw,ownerId:1,enabled:true,contactRevision:1,baseRevision:1,now})).toMatchObject({saved:false});
    const token=await f.issueFixture();await verifyReportRecipient({db:f.raw,ownerId:1,token,vault:f.vault,now});
    await setReportEmailEnabled({db:f.raw,ownerId:1,enabled:true,contactRevision:1,baseRevision:1,now});
    expect(await setReportEmailEnabled({db:f.raw,ownerId:1,enabled:false,contactRevision:1,baseRevision:2,now})).toMatchObject({saved:true});
    f.sqlite.exec("UPDATE life_report_mail_contacts SET paused_reason='complained'");
    expect(await setReportEmailEnabled({db:f.raw,ownerId:1,enabled:true,contactRevision:1,baseRevision:3,now})).toMatchObject({saved:false});
    expect(await f.configure('fixture@example.invalid',1)).toMatchObject({pausedReason:'complained',enabled:false});
  }finally{f.sqlite.close();}
});

it('rolls back encrypted recipient changes if disabling the old delivery flag fails later in the transaction',async()=>{
  const f=await fixture();try{
    await f.configure();const original=f.sqlite.prepare('SELECT * FROM life_report_mail_contacts').get();
    f.sqlite.exec("CREATE TRIGGER fixture_contact_abort BEFORE UPDATE ON life_report_preferences BEGIN SELECT RAISE(ABORT,'fixture contact transaction abort'); END");
    await expect(f.configure('changed@example.invalid',1)).rejects.toThrow('transaction abort');
    expect(f.sqlite.prepare('SELECT * FROM life_report_mail_contacts').get()).toEqual(original);
  }finally{f.sqlite.close();}
});


it('claims one verification slot under racing requests and never persists or returns the inbox token',async()=>{
  const f=await fixture();try{
    await f.configure();const messages:Array<any>=[];
    const provider:ReportMailProvider={identity:'mock-v1',async submit(message){messages.push(message);return {state:'accepted',id:'<fixture-accepted-1@relay.example.invalid>'};}};
    const options={db:f.raw,ownerId:1,vault:f.vault,provider,now};
    const results=await Promise.all(Array.from({length:6},()=>requestReportVerification(options)));
    expect(messages).toHaveLength(1);expect(results.some(r=>r?.state==='accepted')).toBe(true);
    const token=messages[0].text.match(/verify=([A-Za-z0-9_-]{43})/)[1];
    expect(JSON.stringify(results)).not.toContain(token);
    expect(JSON.stringify(f.sqlite.prepare('SELECT * FROM life_report_mail_verifications').all())).not.toContain(token);
    expect(f.sqlite.prepare('SELECT message_json FROM life_report_mail_deliveries').get()).toMatchObject({message_json:null});
    expect(await verifyReportRecipient({...options,token})).toEqual({verified:true});
    expect(await requestReportVerification(options)).toMatchObject({state:'already-verified'});
    expect(messages).toHaveLength(1);expect((await reportMailContactState(f.raw,1,f.vault)).enabled).toBe(false);
  }finally{f.sqlite.close();}
});

it('retains unknown send outcomes and does not resubmit after a provider response or database write is lost',async()=>{
  const f=await fixture();try{
    await f.configure();let calls=0;
    const provider:ReportMailProvider={identity:'mock-v1',async submit(){calls++;throw Error('fixture secret diagnostic');}};
    const options={db:f.raw,ownerId:1,vault:f.vault,provider,now};
    expect(await requestReportVerification(options)).toMatchObject({state:'unknown'});
    expect(await requestReportVerification(options)).toMatchObject({state:'unknown'});expect(calls).toBe(1);
    expect(JSON.stringify(f.sqlite.prepare('SELECT * FROM life_report_mail_deliveries').all())).not.toContain('secret diagnostic');
    const later=new Date(now.getTime()+31*60000);
    provider.submit=async()=>{calls++;return {state:'accepted',id:'fixture-lost-outcome'};};
    f.sqlite.exec("CREATE TRIGGER fixture_outcome_lost BEFORE UPDATE ON life_report_mail_deliveries WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'fixture outcome lost'); END");
    await expect(requestReportVerification({...options,now:later})).rejects.toThrow('outcome lost');
    f.sqlite.exec('DROP TRIGGER fixture_outcome_lost');
    const key=f.sqlite.prepare("SELECT delivery_key FROM life_report_mail_deliveries WHERE state='submitting'").get().delivery_key;
    expect(await submitReportDelivery({...options,key,now:new Date(later.getTime()+61000)})).toMatchObject({state:'unknown'});
    expect(await readReportDelivery(f.raw,1,key,new Date(later.getTime()+61000))).toMatchObject({state:'unknown'});expect(calls).toBe(2);
  }finally{f.sqlite.close();}
});

it('limits new verification requests and keeps admission receipts across UTC days',async()=>{
  const f=await fixture();try{
    await f.configure();let calls=0;
    const provider:ReportMailProvider={identity:'mock-v1',async submit(){calls++;return {state:'accepted',id:'fixture-admitted-'+calls};}};
    const options={db:f.raw,ownerId:1,vault:f.vault,provider,now};
    for(let i=0;i<4;i++)await requestReportVerification({...options,now:new Date(now.getTime()+i*31*60000)});
    expect(calls).toBe(3);
    const original=f.sqlite.prepare('SELECT request_key FROM life_report_mail_admissions ORDER BY created_at LIMIT 1').get().request_key;
    const next=new Date(now.getTime()+86400000);
    expect(await reserveMailSubmission(f.raw,1,original,'verification',next)).toBe('existing');
    await requestReportVerification({...options,now:next});expect(calls).toBe(4);
  }finally{f.sqlite.close();}
});

it('does not submit to a recipient changed between decryption and the durable claim, or without a configured provider',async()=>{
  const f=await fixture();try{
    await f.configure();let calls=0;
    const provider:ReportMailProvider={identity:'mock-v1',async submit(){calls++;return {state:'accepted',id:'must-not-send'};}};
    expect(await requestReportVerification({db:f.raw,ownerId:1,vault:f.vault,now})).toMatchObject({state:'not-configured'});
    expect(await requestReportVerification({db:f.raw,ownerId:1,vault:f.vault,provider:{...provider,identity:''},now})).toMatchObject({state:'not-configured'});
    const open=f.vault.open;let changed=false;f.vault.open=async(ownerId,sealed)=>{const value=await open(ownerId,sealed);if(!changed){changed=true;await f.configure('new@example.invalid',1);}return value;};
    expect(await requestReportVerification({db:f.raw,ownerId:1,vault:f.vault,provider,now})).toMatchObject({state:'paused'});expect(calls).toBe(0);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_mail_admissions').get()).toMatchObject({n:0});
  }finally{f.sqlite.close();}
});


it('uses a whole-provider deadline and retains the quota without automatically retrying the same verification',async()=>{
  const f=await fixture();try{
    await f.configure();let calls=0;
    const provider:ReportMailProvider={identity:'mock-v1',async submit(){calls++;return await new Promise(()=>{});}};
    const options={db:f.raw,ownerId:1,vault:f.vault,provider,now,timeoutMs:10};
    expect(await requestReportVerification(options)).toMatchObject({state:'unknown'});
    expect(await requestReportVerification(options)).toMatchObject({state:'unknown'});expect(calls).toBe(1);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_mail_admissions').get()).toMatchObject({n:1});
  }finally{f.sqlite.close();}
});
