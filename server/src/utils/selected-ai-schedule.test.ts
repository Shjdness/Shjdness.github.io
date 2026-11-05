import {expect,it,vi,beforeEach,afterEach} from 'vitest';
import {mailFixture,now} from './report-mail-fixture';
import {checkinVault} from './checkin-vault';
import {saveCheckin} from './checkin-store';
import {emptyCheckin} from './checkin-format';
import {setSelectedAIConsent,readSelectedAIConsent} from './selected-ai-consent';
import {runReportSchedule} from './report-jobs';
import {runSelectedAISchedule} from './selected-ai-schedule';
import {prepareReportMail} from './report-mail-prepare';
import {submitReportDelivery} from './report-mail-delivery';
import {generateCheckinAnalysis} from './checkin-analysis';
import {decodeReportRow} from './report-history';
const capture=new Date(now.getTime()-3*3600000),at=capture.getTime()/1000;
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(capture);});afterEach(()=>vi.useRealTimers());
const secret=btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+53)));
const answer={version:1,summary:'选定记录的一小步。',modules:{habits:{status:'observed',observations:[{text:'已记录这次练习。',evidence:['H1']}],actions:['按自己的节奏继续。']},checkins:{status:'insufficient',observations:[],actions:[]},diet:{status:'insufficient',observations:[],actions:[]},routine:{status:'insufficient',observations:[],actions:[]}}};
async function fixture(email=true){
 const f=await mailFixture(),vault=await checkinVault(secret),record=emptyCheckin();record.state='confirmed';record.items=[{key:crypto.randomUUID(),kind:'habit',source:null,name:'APPROVED HABIT ONLY',result:'done',note:'',ai:true,email}];
 await saveCheckin(f.raw,vault,1,'2026-11-01',{value:record,baseRevision:0,clientKey:crypto.randomUUID()},capture.getTime()-1000);
 await setSelectedAIConsent({db:f.raw,owner:1,enabled:true,baseRevision:0,allowSelectedAnalysis:true,now:new Date(capture.getTime()-60000)});
 await f.configure();f.sqlite.prepare('UPDATE life_report_mail_contacts SET verified_at=?,enabled_at=?').run(at-120,at-120);
 f.sqlite.exec('UPDATE life_report_preferences SET email_enabled=1');
 f.sqlite.prepare('INSERT INTO life_report_brief_consent(owner_id,revision,enabled_at,updated_at) VALUES(1,1,?,?)').run(at-120,at-120);
 await runReportSchedule(f.raw,capture,{checkins:vault});
 const job=f.sqlite.prepare("SELECT * FROM life_report_jobs WHERE state='ready'").get();
 const saved=await decodeReportRow(1,f.sqlite.prepare('SELECT * FROM life_reports WHERE id=?').get(job.report_id));
 const fetcher=vi.fn(async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]}));
 return {...f,mailVault:f.vault,vault,record,job,saved,fetcher,options:{db:f.raw,vault,apiKey:'FIXTURE ONLY',now:capture,fetcher}};
}
it('analyzes before send time, shares one durable claim/budget with manual calls and freezes a shareable result into mail',async()=>{
 const f=await fixture();try{
  const results=await Promise.all(Array.from({length:5},()=>runSelectedAISchedule(f.options)));expect(results.some(r=>r.processed===1)).toBe(true);expect(f.fetcher).toHaveBeenCalledOnce();
  await generateCheckinAnalysis({...f.options,owner:1,saved:f.saved,scope2Approved:true,enabled:true});expect(f.fetcher).toHaveBeenCalledOnce();
  expect(f.sqlite.prepare('SELECT reserved_fen FROM life_report_ai_budget').get().reserved_fen).toBe(5);
  expect(f.sqlite.prepare('SELECT count(*) n FROM life_report_checkin_analyses').get().n).toBe(1);
  vi.setSystemTime(now);const prepared=await prepareReportMail({db:f.raw,ownerId:1,jobKey:f.job.job_key,providerIdentity:'mock-v1',checkinVault:f.vault,now});if(!('key' in prepared))throw Error('No mail');
  const sent:any[]=[];await submitReportDelivery({db:f.raw,ownerId:1,key:prepared.key,vault:f.mailVault,checkinVault:f.vault,now,provider:{identity:'mock-v1',async submit(message){sent.push(message);return {state:'accepted',id:'mock-selected'};}}});
  expect(sent).toHaveLength(1);expect(sent[0].text).toContain(answer.summary);expect(sent[0].text).toContain('习惯：已记录');
  expect(JSON.stringify(f.sqlite.prepare('SELECT * FROM life_report_private_messages').get())).not.toContain(answer.summary);
 }finally{f.sqlite.close();}
});
it.each([
 'UPDATE life_report_selected_ai_consent SET enabled_at=NULL,revision=revision+1',
 'UPDATE life_report_selected_ai_consent SET revision=revision+1',
 'UPDATE life_report_preferences SET weekly_enabled=0',
 "UPDATE life_checkins SET revision=revision+1,content_hmac='withdrawn'",
])('rechecks automatic consent and scope during atomic admission: %s',async(change)=>{
 const f=await fixture();try{
  const batch=f.raw.batch.bind(f.raw);f.raw.batch=async(statements:any)=>{if(statements.length===3){f.sqlite.exec(change);f.raw.batch=batch;}return batch(statements);};
  await runSelectedAISchedule(f.options);expect(f.fetcher).not.toHaveBeenCalled();expect(f.sqlite.prepare('SELECT count(*) n FROM life_report_ai_reservations').get().n).toBe(0);
 }finally{f.sqlite.close();}
});
it('does not attach an AI-only result to email, refund unknown results, or catch up a new consent',async()=>{
 const f=await fixture(false);try{
  await runSelectedAISchedule(f.options);vi.setSystemTime(now);const p=await prepareReportMail({db:f.raw,ownerId:1,jobKey:f.job.job_key,providerIdentity:'mock-v1',checkinVault:f.vault,now});if(!('key' in p))throw Error('No mail');
  const sent:any[]=[];const mailVault=f.mailVault;
  await submitReportDelivery({db:f.raw,ownerId:1,key:p.key,vault:mailVault,checkinVault:f.vault,now,provider:{identity:'mock-v1',async submit(m){sent.push(m);return {state:'accepted',id:'safe-facts'};}}});
  expect(sent[0].text).not.toContain(answer.summary);expect(sent[0].text).not.toContain('APPROVED HABIT ONLY');
 }finally{f.sqlite.close();}
 const g=await fixture();try{
  g.sqlite.prepare('UPDATE life_report_selected_ai_consent SET enabled_at=?').run(at+1);await runSelectedAISchedule(g.options);expect(g.fetcher).not.toHaveBeenCalled();
  g.sqlite.prepare('UPDATE life_report_selected_ai_consent SET enabled_at=?').run(at-60);g.fetcher.mockImplementation(async()=>{throw Error('fixture provider unavailable');});
  await runSelectedAISchedule(g.options);await runSelectedAISchedule(g.options);expect(g.fetcher).toHaveBeenCalledOnce();expect(g.sqlite.prepare('SELECT reserved_fen FROM life_report_ai_budget').get().reserved_fen).toBe(5);
 }finally{g.sqlite.close();}
});
it('keeps selected consent separate and revision-safe without enabling numeric AI',async()=>{
 const f=await fixture();try{
  const old=await readSelectedAIConsent(f.raw,1);expect(await setSelectedAIConsent({db:f.raw,owner:1,enabled:false,baseRevision:0,now:capture})).toMatchObject({saved:false,reason:'conflict'});
  expect(await setSelectedAIConsent({db:f.raw,owner:1,enabled:false,baseRevision:old.revision,now:capture})).toMatchObject({saved:true,enabled:false,revision:2});
  expect(f.sqlite.prepare('SELECT ai_enabled FROM life_report_preferences').get().ai_enabled).toBe(0);
  await runSelectedAISchedule(f.options);expect(f.fetcher).not.toHaveBeenCalled();
 }finally{f.sqlite.close();}
});
it('degrades at the shared monthly cap and never withholds mail beyond the pending deadline',async()=>{
 const f=await fixture();try{
  f.sqlite.exec("INSERT INTO life_report_ai_budget(month,reserved_fen) VALUES('2026-11',1000)");
  await runSelectedAISchedule(f.options);expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.sqlite.prepare('SELECT reserved_fen FROM life_report_ai_budget').get().reserved_fen).toBe(1000);
  expect(f.sqlite.prepare('SELECT state FROM life_report_checkin_analyses').get().state).toBe('statistics');
  vi.setSystemTime(now);expect((await prepareReportMail({db:f.raw,ownerId:1,jobKey:f.job.job_key,providerIdentity:'mock-v1',checkinVault:f.vault,now})).state).toBe('queued');
 }finally{f.sqlite.close();}
 const g=await fixture();try{
  // Provider has received the request but has not returned. The durable row is
  // pending; mailbox preparation must wait briefly then freeze a facts fallback.
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  g.fetcher.mockImplementation(async()=>{entered();await held;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]});});
  const analysis=runSelectedAISchedule({...g.options,now});await started;
  vi.setSystemTime(now);expect(await prepareReportMail({db:g.raw,ownerId:1,jobKey:g.job.job_key,providerIdentity:'mock-v1',checkinVault:g.vault,now})).toMatchObject({state:'analysis-pending'});
  const later=new Date(now.getTime()+61000);vi.setSystemTime(later);
  expect((await prepareReportMail({db:g.raw,ownerId:1,jobKey:g.job.job_key,providerIdentity:'mock-v1',checkinVault:g.vault,now:later})).state).toBe('queued');
  release();await analysis;expect(g.fetcher).toHaveBeenCalledOnce();
 }finally{g.sqlite.close();}
});
