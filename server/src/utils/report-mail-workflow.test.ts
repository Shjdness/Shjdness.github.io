import {expect,it,vi,beforeEach,afterEach} from 'vitest';
import {mailFixture,now,seconds} from './report-mail-fixture';
// Freeze wall-clock Date too: production admission deliberately compares it with
// the scenario clock. Otherwise these historical fixtures expire as days pass.
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);});
afterEach(()=>vi.useRealTimers());
import {requestReportVerification,submitReportDelivery,type ReportMailProvider} from './report-mail-delivery';
import {verifyReportRecipient,setReportEmailEnabled,reportMailContactState} from './report-mail-contacts';
import {applyReportMailEvent,type ReportMailEvent} from './report-mail-events';
import {prepareReportMail} from './report-mail-prepare';
import {runReportSchedule} from './report-jobs';

async function verifiedFixture(enable=true){
  const f=await mailFixture(),sent:Array<any>=[];
  const provider:ReportMailProvider={identity:'mock-v1',async submit(message){sent.push(message);return {state:'accepted',id:`<fixture-${sent.length}@relay.example.invalid>`};}};
  await f.configure();await requestReportVerification({db:f.raw,ownerId:1,vault:f.vault,provider,now});
  const token=sent[0].text.match(/verify=([A-Za-z0-9_-]{43})/)[1];
  await verifyReportRecipient({db:f.raw,ownerId:1,vault:f.vault,token,now});
  if(enable)await setReportEmailEnabled({db:f.raw,ownerId:1,enabled:true,contactRevision:1,baseRevision:1,now});
  const verification=f.sqlite.prepare("SELECT delivery_key,provider_id FROM life_report_mail_deliveries WHERE kind='verification'").get();
  const event=(status:ReportMailEvent['status'],eventId='event-'+status):ReportMailEvent=>({eventId,status,deliveryKey:verification.delivery_key,providerId:verification.provider_id,providerIdentity:provider.identity});
  return {...f,sent,provider,event};
}

it('keeps callback states monotone, deduplicates/conflict-checks events and suppresses a bounced/complaining recipient',async()=>{
  const f=await verifiedFixture();try{
    expect(await applyReportMailEvent(f.raw,f.event('delivered'),now)).toMatchObject({applied:true});
    const before=f.sqlite.prepare('SELECT total_changes() AS n').get().n;
    expect(await applyReportMailEvent(f.raw,f.event('delivered'),now)).toMatchObject({duplicate:true});
    expect(await applyReportMailEvent(f.raw,f.event('accepted'),now)).toMatchObject({unchanged:true});
    expect(f.sqlite.prepare('SELECT total_changes() AS n').get().n).toBe(before);
    expect(await applyReportMailEvent(f.raw,f.event('bounced','event-delivered'),now)).toMatchObject({conflict:true});
    expect(await applyReportMailEvent(f.raw,f.event('bounced'),now)).toMatchObject({applied:true});
    expect(await reportMailContactState(f.raw,1,f.vault)).toMatchObject({enabled:false,pausedReason:'bounced'});
    expect(await applyReportMailEvent(f.raw,f.event('complained'),now)).toMatchObject({applied:true});
    expect(await applyReportMailEvent(f.raw,f.event('delivered','late-delivered'),now)).toMatchObject({unchanged:true});
    expect(f.sqlite.prepare('SELECT state FROM life_report_mail_deliveries').get()).toMatchObject({state:'complained'});
    expect(await reportMailContactState(f.raw,1,f.vault)).toMatchObject({pausedReason:'complained'});
  }finally{f.sqlite.close();}
});

it('refuses mismatched provider proofs and does not suppress a new recipient because an old address bounces',async()=>{
  const f=await verifiedFixture();try{
    expect(await applyReportMailEvent(f.raw,{...f.event('bounced'),providerId:'different-id'},now)).toMatchObject({ignored:true});
    await f.configure('new@example.invalid',1);
    await requestReportVerification({db:f.raw,ownerId:1,vault:f.vault,provider:f.provider,now});
    const token=f.sent[1].text.match(/verify=([A-Za-z0-9_-]{43})/)[1];
    await verifyReportRecipient({db:f.raw,ownerId:1,vault:f.vault,token,now});
    await setReportEmailEnabled({db:f.raw,ownerId:1,enabled:true,contactRevision:2,baseRevision:3,now});
    expect(await applyReportMailEvent(f.raw,f.event('bounced'),now)).toMatchObject({applied:true});
    expect(await reportMailContactState(f.raw,1,f.vault)).toMatchObject({enabled:true,pausedReason:null,maskedRecipient:'n***@example.invalid'});
  }finally{f.sqlite.close();}
});

it('rolls the event, delivery and suppression back together if a later pause write fails',async()=>{
  const f=await verifiedFixture();try{
    f.sqlite.exec("CREATE TRIGGER fixture_event_abort BEFORE UPDATE ON life_report_preferences WHEN NEW.email_enabled=0 BEGIN SELECT RAISE(ABORT,'fixture event transaction abort'); END");
    await expect(applyReportMailEvent(f.raw,f.event('bounced'),now)).rejects.toThrow('transaction abort');
    expect(f.sqlite.prepare('SELECT state FROM life_report_mail_deliveries').get()).toMatchObject({state:'accepted'});
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_mail_events').get()).toMatchObject({n:0});
    expect((await reportMailContactState(f.raw,1,f.vault)).enabled).toBe(true);
    f.sqlite.exec('DROP TRIGGER fixture_event_abort');expect(await applyReportMailEvent(f.raw,f.event('bounced'),now)).toMatchObject({applied:true});
  }finally{f.sqlite.close();}
});

it('preserves a callback that arrives before the submit response instead of downgrading it to accepted',async()=>{
  const f=await mailFixture();try{
    await f.configure();
    const provider:ReportMailProvider={identity:'mock-v1',async submit(message){
      await applyReportMailEvent(f.raw,{eventId:'fast-delivery',deliveryKey:message.deliveryKey,providerId:'fixture-fast',providerIdentity:'mock-v1',status:'delivered'},now);
      return {state:'accepted',id:'fixture-fast'};
    }};
    expect(await requestReportVerification({db:f.raw,ownerId:1,vault:f.vault,provider,now})).toMatchObject({state:'delivered',providerAccepted:true});
  }finally{f.sqlite.close();}
});

it('freezes one numeric report message, excludes source text and reuses it without another provider submission',async()=>{
  const f=await verifiedFixture();try{
    f.sqlite.prepare("INSERT INTO life_todos(owner_id,content,type,completed,completed_at) VALUES(1,'NEVER_IN_MAIL_SOURCE','task',1,?)").run(seconds-86400);
    await runReportSchedule(f.raw,now);
    const job=f.sqlite.prepare('SELECT job_key FROM life_report_jobs WHERE owner_id=1').get().job_key;
    const options={db:f.raw,ownerId:1,jobKey:job,providerIdentity:f.provider.identity,now};
    const prepared=await prepareReportMail(options);expect(prepared.state).toBe('queued');
    if(!('key' in prepared))throw Error('Missing prepared mail key');
    const original=f.sqlite.prepare("SELECT message_json FROM life_report_mail_deliveries WHERE kind='report'").get().message_json;
    expect(original).not.toContain('NEVER_IN_MAIL_SOURCE');expect(original).not.toContain('fixture@example.invalid');
    expect(original).toContain('包含在上周统计中，不重复相加');
    const submitted=await submitReportDelivery({db:f.raw,ownerId:1,key:prepared.key,vault:f.vault,provider:f.provider,now});expect(submitted?.state).toBe('accepted');
    expect((await prepareReportMail(options)).state).toBe('accepted');
    await submitReportDelivery({db:f.raw,ownerId:1,key:prepared.key,vault:f.vault,provider:f.provider,now});
    expect(f.sent).toHaveLength(2);expect(f.sqlite.prepare("SELECT message_json FROM life_report_mail_deliveries WHERE kind='report'").get().message_json).toBe(original);
  }finally{f.sqlite.close();}
});

it('does not backfill old occurrences after enabling or resuming email, and does not reset the cutoff on unchanged retries',async()=>{
  const f=await verifiedFixture(false);try{
    await runReportSchedule(f.raw,now);const old=f.sqlite.prepare('SELECT job_key FROM life_report_jobs').get().job_key;
    const enabled=new Date(now.getTime()+60000);
    await setReportEmailEnabled({db:f.raw,ownerId:1,enabled:true,contactRevision:1,baseRevision:1,now:enabled});
    const before=f.sqlite.prepare('SELECT total_changes() AS n FROM life_report_mail_contacts').get().n;
    expect(await setReportEmailEnabled({db:f.raw,ownerId:1,enabled:true,contactRevision:1,baseRevision:1,now:new Date(enabled.getTime()+60000)})).toMatchObject({saved:true,reason:'unchanged'});
    expect(f.sqlite.prepare('SELECT total_changes() AS n FROM life_report_mail_contacts').get().n).toBe(before);
    expect(await prepareReportMail({db:f.raw,ownerId:1,jobKey:old,providerIdentity:f.provider.identity,now:enabled})).toMatchObject({state:'disabled'});
    const tomorrow=new Date('2026-11-03T01:15:00Z');await runReportSchedule(f.raw,tomorrow);
    const next=f.sqlite.prepare("SELECT job_key FROM life_report_jobs WHERE kind='daily'").get().job_key;
    expect((await prepareReportMail({db:f.raw,ownerId:1,jobKey:next,providerIdentity:f.provider.identity,now:tomorrow})).state).toBe('queued');
  }finally{f.sqlite.close();}
});


it('does not grow replay rows when distinct event IDs race to report the same delivery state',async()=>{
  const f=await verifiedFixture();try{
    const results=await Promise.all(Array.from({length:8},(_,i)=>applyReportMailEvent(f.raw,f.event('delivered','distinct-delivery-'+i),now)));
    expect(results.filter(r=>r.applied)).toHaveLength(1);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_mail_events').get()).toMatchObject({n:1});
  }finally{f.sqlite.close();}
});
