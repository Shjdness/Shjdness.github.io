import {expect,it,vi} from 'vitest';
import {mailFixture,now,seconds} from './report-mail-fixture';
import {runReportSchedule} from './report-jobs';
import {runReportMailSchedule,runConfiguredReportMail} from './report-mail-schedule';
import type {ReportMailProvider} from './report-mail-delivery';

async function fixture(outcome:'accepted'|'unknown'='accepted'){
  const f=await mailFixture(),send=vi.fn(async()=>outcome==='accepted'?{state:'accepted' as const,id:'<fixture@relay.example.invalid>'}:{state:'unknown' as const});
  await f.configure();f.sqlite.exec(`UPDATE life_report_mail_contacts SET verified_at=${seconds-10},enabled_at=${seconds-10}; UPDATE life_report_preferences SET email_enabled=1`);
  await runReportSchedule(f.raw,now);
  const provider:ReportMailProvider={identity:'mock-v1',submit:send};return {...f,send,provider};
}

it('sends one frozen merged report under competing cron ticks, then does no extra writes or submissions',async()=>{
  const f=await fixture();try{
    const options={db:f.raw,vault:f.vault,provider:f.provider,now};
    await Promise.all(Array.from({length:5},()=>runReportMailSchedule(options)));
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_mail_admissions').get().n).toBe(1);
    const before=f.sqlite.prepare('SELECT total_changes() AS n').get().n;
    expect(await runReportMailSchedule(options)).toEqual({processed:0,failures:0});
    expect(f.sqlite.prepare('SELECT total_changes() AS n').get().n).toBe(before);
  }finally{f.sqlite.close();}
});

it('does not resend unknown outcomes, process revoked or paused owners, or query D1 when globally off',async()=>{
  const f=await fixture('unknown');try{
    const options={db:f.raw,vault:f.vault,provider:f.provider,now};
    await runReportMailSchedule(options);await runReportMailSchedule(options);expect(f.send).toHaveBeenCalledTimes(1);
    f.sqlite.exec('UPDATE users SET permission=0 WHERE id=1');expect((await runReportMailSchedule(options)).processed).toBe(0);
    f.sqlite.exec('UPDATE users SET permission=1 WHERE id=1; UPDATE life_report_preferences SET email_enabled=0');expect((await runReportMailSchedule(options)).processed).toBe(0);
    const db={prepare:vi.fn(()=>{throw Error('Must not query');})};
    expect(await runConfiguredReportMail({DB:db} as any)).toEqual({processed:0,failures:0});expect(db.prepare).not.toHaveBeenCalled();
  }finally{f.sqlite.close();}
});

it('rotates past damaged snapshots instead of starving a later valid owner',async()=>{
  const f=await fixture();try{
    const original=f.sqlite.prepare('SELECT * FROM life_report_jobs').get();
    for(let i=10;i<14;i++){
      f.sqlite.prepare("INSERT INTO users(id,username,openid,permission) VALUES(?,?,?,1)").run(i,'fixture-'+i,'fixture-'+i);
      f.sqlite.prepare('INSERT INTO life_report_preferences(owner_id,daily_enabled,weekly_enabled,email_enabled) VALUES(?,1,1,1)').run(i);
      f.sqlite.prepare('INSERT INTO life_report_mail_contacts(owner_id,email_sealed,fingerprint,revision,verified_at,enabled_at) SELECT ?,email_sealed,fingerprint,revision,?,? FROM life_report_mail_contacts WHERE owner_id=1').run(i,seconds-20,seconds-20);
      // Synthetic damaged binding: report belongs to a different owner.
      f.sqlite.prepare("INSERT INTO life_report_jobs(job_key,owner_id,kind,period_start,period_end,anchor_at,include_daily,state,report_id) VALUES(?,?,'weekly',?,?,?,0,'ready',?)").run(String(i).padStart(64,'0'),i,original.period_start,original.period_end,seconds-1,original.report_id);
    }
    const options={db:f.raw,vault:f.vault,provider:f.provider,now};
    expect(await runReportMailSchedule(options)).toEqual({processed:3,failures:3});expect(f.send).not.toHaveBeenCalled();
    expect(await runReportMailSchedule(options)).toEqual({processed:2,failures:1});expect(f.send).toHaveBeenCalledTimes(1);
  }finally{f.sqlite.close();}
});
