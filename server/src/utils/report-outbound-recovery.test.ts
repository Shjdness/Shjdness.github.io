import 'reflect-metadata';
import {drizzle} from 'drizzle-orm/d1';
import {SignJWT} from 'jose';
import {expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import {mailFixture,now,seconds} from './report-mail-fixture';
import {setReportAIConsent} from './report-ai-consent';
import {runReportSchedule} from './report-jobs';
import {runReportAISchedule,runConfiguredReportAI} from './report-ai-schedule';
import {runReportMailSchedule,runConfiguredReportMail} from './report-mail-schedule';
import {LifeBackupService} from '../services/life-backup';
import {runRequestContext} from './di';
import {validateBackup,encryptBackup,decryptBackup} from '../../../client/src/features/life/backup-format';

it('exports the real owner-scoped v2-v4 HTTP snapshots without operational proofs/consent/ledgers and preserves encrypted readability',async()=>{
  const f=await mailFixture();try{
    await f.configure();const tokenProof=await f.issueFixture();
    await setReportAIConsent({db:f.raw,ownerId:1,enabled:true,allowNumericAnalysis:true,baseRevision:1,now:new Date(now.getTime()-1000)});
    await runReportSchedule(f.raw,now);
    f.sqlite.prepare('UPDATE life_report_mail_contacts SET verified_at=?,enabled_at=?').run(seconds-10,seconds-10);f.sqlite.exec('UPDATE life_report_preferences SET email_enabled=1');
    f.sqlite.exec("INSERT INTO life_report_ai_budget(month,reserved_fen) VALUES('2026-11',995);INSERT INTO life_report_ai_reservations(request_key,month,reserved_fen) VALUES('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-11',5)");
    const contact=f.sqlite.prepare('SELECT email_sealed FROM life_report_mail_contacts').get();
    const db=drizzle(f.raw,{schema}),env={DB:f.raw,JWT_SECRET:'synthetic-backup-jwt-32-characters-only',RIN_GITHUB_CLIENT_ID:'fixture',RIN_GITHUB_CLIENT_SECRET:'fixture'} as any;
    const jwt=await new SignJWT({id:1}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));
    const service=runRequestContext(env,db,()=>LifeBackupService());
    for(const version of [2,3,4]){
      const response=await runRequestContext(env,db,()=>service.handle(new Request('https://api.example.invalid/life/backup'+(version===2?'':'?version='+version),{headers:{Authorization:'Bearer '+jwt}})));
      expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');
      const text=await response.text(),value=JSON.parse(text);expect(value.version).toBe(version);expect(Object.keys(value.data)).toHaveLength(version===2?15:version===3?17:18);
      for(const forbidden of [tokenProof,contact.email_sealed,'fixture@example.invalid','life_report_ai_consent','life_report_mail_deliveries','life_report_ai_reservations',env.JWT_SECRET])expect(text).not.toContain(forbidden);
      expect((await validateBackup(value,1)).version).toBe(version);
      if(version===4){const encrypted=await encryptBackup(value,'isolated-outbound-backup-passphrase');expect((await decryptBackup(encrypted,'isolated-outbound-backup-passphrase',1)).data.lifeReports).toHaveLength(2);}
    }
    expect(f.sqlite.prepare('SELECT reserved_fen FROM life_report_ai_budget').get().reserved_fen).toBe(995);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_ai_reservations').get().n).toBe(1);
  }finally{f.sqlite.close();}
});

it('stops both configured external schedulers before D1 when the maintenance gate is closed',async()=>{
  const db={prepare:vi.fn(()=>{throw Error('No D1 access while globally paused');})};
  const env={DB:db,REPORT_OUTBOUND_PAUSED:'true',REPORT_MAIL_ENABLED:'true',DEEPSEEK_API_KEY:'synthetic-only'} as any;
  expect(await runConfiguredReportAI(env)).toEqual({processed:0,failures:0});
  expect(await runConfiguredReportMail(env)).toEqual({processed:0,failures:0});expect(db.prepare).not.toHaveBeenCalled();
});

it('restored flags alone cannot resume outbound work or spend, even with an existing ready report and keys',async()=>{
  const f=await mailFixture();try{
    await runReportSchedule(f.raw,now);
    // Simulates legacy/raw preference restoration without operational consent.
    f.sqlite.exec('UPDATE life_report_preferences SET ai_enabled=1,email_enabled=1');
    const fetcher=vi.fn(async()=>{throw Error('Must not call AI');}),submit=vi.fn(async()=>({state:'accepted' as const,id:'unexpected'}));
    expect(await runReportAISchedule({db:f.raw,apiKey:'synthetic-only',fetcher,now})).toEqual({processed:0,failures:0});
    expect(await runReportMailSchedule({db:f.raw,vault:f.vault,provider:{identity:'mock-v1',submit},now})).toEqual({processed:0,failures:0});
    expect(fetcher).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_ai_reservations').get().n).toBe(0);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_mail_admissions').get().n).toBe(0);
  }finally{f.sqlite.close();}
});
