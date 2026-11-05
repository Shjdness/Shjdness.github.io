import {expect,it,vi,beforeEach,afterEach} from 'vitest';
import {mailFixture,now,seconds} from './report-mail-fixture';
import {checkinVault} from './checkin-vault';
import {runReportSchedule} from './report-jobs';
import {prepareReportMail} from './report-mail-prepare';
import {submitReportDelivery,type ReportMailProvider} from './report-mail-delivery';
import {PRIVATE_MAIL_MARKER} from './report-private-mail';
import {runReportMailSchedule} from './report-mail-schedule';
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);});
afterEach(()=>vi.useRealTimers());
const secret=btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+33)));
async function fixture(consent=true){
 const f=await mailFixture(),details=await checkinVault(secret),sent:any[]=[];
 await f.configure();
 f.sqlite.prepare('UPDATE life_report_mail_contacts SET verified_at=?,enabled_at=?').run(seconds-10,seconds-10);
 f.sqlite.exec("UPDATE life_report_preferences SET email_enabled=1,daily_time='08:00'; INSERT INTO daily_basics(owner_id,date,content) VALUES(1,'2026-11-02','PRIVATE MORNING PRIORITY'); INSERT INTO life_todos(owner_id,content,type,completed) VALUES(1,'PRIVATE TASK NAME','task',0)");
 if(consent)f.sqlite.prepare('INSERT INTO life_report_brief_consent(owner_id,enabled_at,revision,updated_at) VALUES(1,?,1,?)').run(seconds-10,seconds-10);
 await runReportSchedule(f.raw,now,{checkins:details});
 const job=f.sqlite.prepare("SELECT job_key FROM life_report_jobs WHERE state='ready' AND owner_id=1").get().job_key;
 const provider:ReportMailProvider={identity:'mock-v1',async submit(message){sent.push(message);return {state:'accepted',id:'fixture-private'};}};
 const prepare=()=>prepareReportMail({db:f.raw,ownerId:1,jobKey:job,providerIdentity:provider.identity,checkinVault:details,now});
 const submit=(key:string,vault=details)=>submitReportDelivery({db:f.raw,ownerId:1,key,vault:f.vault,checkinVault:vault,provider,now});
 return {...f,details,sent,provider,prepare,submit,job};
}
it('prepares only ciphertext and sends one fixed rich report under competing cron ticks',async()=>{
 const f=await fixture();try{
  const prepared=await f.prepare();if(!('key' in prepared))throw Error('No prepared key');
  expect(f.sqlite.prepare("SELECT message_json FROM life_report_mail_deliveries WHERE kind='report'").get().message_json).toBe(PRIVATE_MAIL_MARKER);
  const sealed=f.sqlite.prepare('SELECT * FROM life_report_private_messages').get();expect(JSON.stringify(sealed)).not.toContain('PRIVATE');
  f.sqlite.exec("UPDATE daily_basics SET content='CHANGED AFTER SNAPSHOT'");
  const options={db:f.raw,vault:f.vault,checkinVault:f.details,provider:f.provider,now};
  await Promise.all(Array.from({length:5},()=>runReportMailSchedule(options)));
  expect(f.sent).toHaveLength(1);expect(f.sent[0].text).toContain('PRIVATE MORNING PRIORITY');expect(f.sent[0].text).toContain('PRIVATE TASK NAME');expect(f.sent[0].text).not.toContain('CHANGED AFTER SNAPSHOT');
  expect(f.sqlite.prepare('SELECT count(*) n FROM life_report_mail_admissions').get().n).toBe(1);
  expect((await f.prepare()).state).toBe('accepted');expect(f.sqlite.prepare('SELECT sealed_json FROM life_report_private_messages').get().sealed_json).toBe(sealed.sealed_json);
 }finally{f.sqlite.close();}
});
it.each([
 "UPDATE life_report_brief_consent SET enabled_at=NULL,revision=revision+1",
 "UPDATE life_report_brief_consent SET revision=revision+1",
 "UPDATE life_report_briefs SET outbound_eligible=0",
 "UPDATE life_report_checkin_snapshots SET outbound_eligible=0",
 "INSERT INTO life_checkins(owner_id,record_date,revision,client_key,sealed_json,content_hmac,updated_at) VALUES(1,'2026-11-01',1,'00000000-0000-0000-0000-000000000000','unreadable','changed',1)",
])('blocks private scope changes after claim and before admission: %s',async(change)=>{
 const f=await fixture();try{
  const prepared=await f.prepare();if(!('key' in prepared))throw Error('No key');
  const original=f.raw.batch.bind(f.raw);f.raw.batch=async(statements:any)=>{
   expect(f.sqlite.prepare("SELECT state FROM life_report_mail_deliveries WHERE kind='report'").get().state).toBe('submitting');
   f.sqlite.exec(change);f.raw.batch=original;return original(statements);
  };
  expect(await f.submit(prepared.key)).toMatchObject({state:'paused',errorCode:'disabled'});
  expect(f.sent).toHaveLength(0);expect(f.sqlite.prepare('SELECT count(*) n FROM life_report_mail_admissions').get().n).toBe(0);
  await f.submit(prepared.key);expect(f.sent).toHaveLength(0);
 }finally{f.sqlite.close();}
});
it('keeps old numeric consent as a numeric fallback, with no private sidecar',async()=>{
 const f=await fixture(false);try{
  const prepared=await f.prepare();if(!('key' in prepared))throw Error('No key');await f.submit(prepared.key);
  expect(f.sent).toHaveLength(1);expect(f.sent[0].text).not.toContain('PRIVATE');expect(f.sqlite.prepare('SELECT count(*) n FROM life_report_private_messages').get().n).toBe(0);
 }finally{f.sqlite.close();}
});
it('retains unknown admission without replay or replacement, even if consent is renewed',async()=>{
 const f=await fixture();try{
  f.provider.submit=async(message)=>{f.sent.push(message);return {state:'unknown'};};
  const prepared=await f.prepare();if(!('key' in prepared))throw Error('No key');
  expect(await f.submit(prepared.key)).toMatchObject({state:'unknown'});
  const before=f.sqlite.prepare('SELECT sealed_json FROM life_report_private_messages').get().sealed_json;
  f.sqlite.exec('UPDATE life_report_brief_consent SET revision=revision+1');
  expect((await f.prepare()).state).toBe('unknown');await f.submit(prepared.key);
  expect(f.sent).toHaveLength(1);expect(f.sqlite.prepare('SELECT count(*) n FROM life_report_mail_admissions').get().n).toBe(1);
  expect(f.sqlite.prepare('SELECT sealed_json FROM life_report_private_messages').get().sealed_json).toBe(before);
 }finally{f.sqlite.close();}
});
it('rejects ciphertext substitution and another owner before any provider submission',async()=>{
 const f=await fixture();try{
  const prepared=await f.prepare();if(!('key' in prepared))throw Error('No key');
  expect(await submitReportDelivery({db:f.raw,ownerId:2,key:prepared.key,vault:f.vault,checkinVault:f.details,provider:f.provider,now})).toBeNull();
  const sealed=await f.details.sealPayload(2,'report-mail',prepared.key,{message:{subject:'forged',text:'forged',html:''}});
  f.sqlite.prepare('UPDATE life_report_private_messages SET sealed_json=?').run(sealed);
  expect(await f.submit(prepared.key)).toMatchObject({state:'paused'});expect(f.sent).toHaveLength(0);
 }finally{f.sqlite.close();}
});
it('rolls original delivery back if sidecar storage fails; a lost key pauses rather than replacing or resending',async()=>{
 const f=await fixture();try{
  f.sqlite.exec("CREATE TRIGGER private_abort BEFORE INSERT ON life_report_private_messages BEGIN SELECT RAISE(ABORT,'fixture private abort'); END");
  await expect(f.prepare()).rejects.toThrow('fixture private abort');expect(f.sqlite.prepare('SELECT count(*) n FROM life_report_mail_deliveries').get().n).toBe(0);
  f.sqlite.exec('DROP TRIGGER private_abort');const prepared=await f.prepare();if(!('key' in prepared))throw Error('No key');
  expect(await submitReportDelivery({db:f.raw,ownerId:1,key:prepared.key,vault:f.vault,provider:f.provider,now})).toMatchObject({state:'paused'});
  await f.submit(prepared.key);expect(f.sent).toHaveLength(0);
 }finally{f.sqlite.close();}
});
