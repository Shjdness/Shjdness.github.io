import {expect,it,vi,beforeEach,afterEach} from 'vitest';
import {mailFixture,now,seconds} from './report-mail-fixture';
// Freeze wall-clock Date too: production admission deliberately compares it with
// the scenario clock. Otherwise these historical fixtures expire as days pass.
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);});
afterEach(()=>vi.useRealTimers());
import {runReportSchedule} from './report-jobs';
import {readReportAIConsent,setReportAIConsent} from './report-ai-consent';
import {runReportAISchedule} from './report-ai-schedule';
import {decodeReportRow} from './report-history';
import {generateReportAnalysis} from './report-analysis';
import {prepareReportMail} from './report-mail-prepare';
const analysis={summary:'记录中有一些小进展。',observations:['有专注记录。'],actions:['选择一件容易开始的小事。']};
const response=()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(analysis)}}]});
async function fixture(){
  const f=await mailFixture();
  await setReportAIConsent({db:f.raw,ownerId:1,enabled:true,allowNumericAnalysis:true,baseRevision:0,now:new Date(now.getTime()-1000)});
  await runReportSchedule(f.raw,now);const job=f.sqlite.prepare('SELECT * FROM life_report_jobs').get();
  const saved=await decodeReportRow(1,f.sqlite.prepare('SELECT * FROM life_reports WHERE id=?').get(job.report_id));
  return {...f,job,saved};
}
it('requires numeric opt-in and revision, keeps retry cutoff, and lets withdrawal bypass exhausted activity budget',async()=>{
  const f=await mailFixture();try{
    expect(await setReportAIConsent({db:f.raw,ownerId:1,enabled:true,baseRevision:0,now})).toMatchObject({saved:false,reason:'consent-required'});
    expect(await setReportAIConsent({db:f.raw,ownerId:1,enabled:true,allowNumericAnalysis:true,baseRevision:0,now})).toMatchObject({saved:true,enabled:true,enabledAt:seconds});
    const before=f.sqlite.prepare('SELECT total_changes() AS n').get().n;
    expect(await setReportAIConsent({db:f.raw,ownerId:1,enabled:true,allowNumericAnalysis:true,baseRevision:0,now:new Date(now.getTime()+1000)})).toMatchObject({saved:true,enabledAt:seconds});
    expect(f.sqlite.prepare('SELECT total_changes() AS n').get().n).toBe(before);
    expect(await setReportAIConsent({db:f.raw,ownerId:1,enabled:false,baseRevision:0,now})).toMatchObject({saved:false,reason:'conflict'});
    f.sqlite.exec("UPDATE rss_write_budget SET reserved=2000 WHERE day LIKE 'reports:%'");
    expect(await setReportAIConsent({db:f.raw,ownerId:1,enabled:false,baseRevision:1,now})).toMatchObject({saved:true,enabled:false,enabledAt:null});
  }finally{f.sqlite.close();}
});
it('shares one durable numeric-only result/admission across manual and racing scheduled calls, including merged weekly reports',async()=>{
  const f=await fixture();try{
    const fetcher=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));const metrics=JSON.parse(body.messages[1].content);
      expect(Object.values(metrics).every(Number.isSafeInteger)).toBe(true);
      expect(Object.keys(metrics).sort()).toEqual(['achievements','completedTasks','earlyFocusSessions','focusSessions','habitRecords','newIdeas','noteDays','periodDays','recordedFocusMinutes'].sort());
      return response();
    });
    await Promise.all([generateReportAnalysis({db:f.raw,ownerId:1,saved:f.saved,enabled:true,apiKey:'fixture-only',fetcher,now}),...Array.from({length:4},()=>runReportAISchedule({db:f.raw,apiKey:'fixture-only',fetcher,now}))]);
    expect(fetcher).toHaveBeenCalledTimes(1);expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_analyses').get().n).toBe(1);
    expect(f.sqlite.prepare('SELECT reserved_fen FROM life_report_ai_budget').get().reserved_fen).toBe(5);
    expect(await runReportAISchedule({db:f.raw,apiKey:'fixture-only',fetcher,now})).toEqual({processed:0,failures:0});
  }finally{f.sqlite.close();}
});
it('does not analyze old occurrences after enabling, missing keys, stale prices, unknown outcomes or revoked owners',async()=>{
  const f=await fixture();try{
    const fetcher=vi.fn(async()=>{throw Error('Unknown provider outcome');});
    f.sqlite.prepare('UPDATE life_report_ai_consent SET enabled_at=?').run(seconds+1);
    expect((await runReportAISchedule({db:f.raw,apiKey:'fixture-only',fetcher,now})).processed).toBe(0);
    f.sqlite.prepare('UPDATE life_report_ai_consent SET enabled_at=?').run(seconds-1);
    f.sqlite.exec('UPDATE users SET permission=0 WHERE id=1');expect((await runReportAISchedule({db:f.raw,apiKey:'fixture-only',fetcher,now})).processed).toBe(0);
    f.sqlite.exec('UPDATE users SET permission=1 WHERE id=1');
    expect((await runReportAISchedule({db:f.raw,fetcher,now})).processed).toBe(0);
    expect((await runReportAISchedule({db:f.raw,apiKey:'fixture-only',fetcher,now:new Date('2026-12-02')})).processed).toBe(0);
    await runReportAISchedule({db:f.raw,apiKey:'fixture-only',fetcher,now});await runReportAISchedule({db:f.raw,apiKey:'fixture-only',fetcher,now});expect(fetcher).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare('SELECT state FROM life_report_analyses').get().state).toBe('unknown');
  }finally{f.sqlite.close();}
});
it('rechecks withdrawal inside monthly admission after winning the claim, spending no reservation or external call',async()=>{
  const f=await fixture();try{
    const prepare=f.raw.prepare.bind(f.raw),fetcher=vi.fn(async()=>response());let paused=false;
    f.raw.prepare=(sql:string)=>{if(sql.startsWith('INSERT INTO life_report_ai_budget')&&!paused){paused=true;f.sqlite.exec('UPDATE life_report_preferences SET ai_enabled=0');}return prepare(sql);};
    await runReportAISchedule({db:f.raw,apiKey:'fixture-only',fetcher,now});
    expect(fetcher).not.toHaveBeenCalled();expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_ai_reservations').get().n).toBe(0);
    expect(await readReportAIConsent(f.raw,1)).toMatchObject({enabled:false});
  }finally{f.sqlite.close();}
});
it('waits briefly for opted-in analysis before freezing a mail, but degrades to statistics after a bounded delay',async()=>{
  const f=await fixture();try{
    await f.configure();f.sqlite.prepare('UPDATE life_report_mail_contacts SET verified_at=?,enabled_at=?').run(seconds-10,seconds-10);f.sqlite.exec('UPDATE life_report_preferences SET email_enabled=1');
    const options={db:f.raw,ownerId:1,jobKey:f.job.job_key,providerIdentity:'mock-v1',includeAnalysis:true,awaitAutomaticAnalysis:true};
    expect((await prepareReportMail({...options,now})).state).toBe('analysis-pending');
    expect((await prepareReportMail({...options,now:new Date(now.getTime()+601000)})).state).toBe('queued');
    expect(f.sqlite.prepare("SELECT message_json FROM life_report_mail_deliveries WHERE kind='report'").get().message_json).toContain('本次为统计版');
  }finally{f.sqlite.close();}
});
