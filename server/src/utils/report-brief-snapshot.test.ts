import 'reflect-metadata';
import {expect,it} from 'vitest';
import {drizzle} from 'drizzle-orm/d1';
import {SignJWT} from 'jose';
import * as schema from '../db/schema';
import {runRequestContext} from './di';
import {LifeReportsService} from '../services/life-reports';
import {LifeBackupService} from '../services/life-backup';
import {validateBackup,encryptBackup,decryptBackup} from '../../../client/src/features/life/backup-format';
import {reportDigest} from './report-analysis-format';
import {mailFixture,now} from './report-mail-fixture';
import {checkinVault} from './checkin-vault';
import {reportWindow} from './life-report';
import {previewLifeReport} from './report-data';
import {saveReportSnapshot} from './report-history';
import {saveReportWithCheckins,readReportCheckins} from './report-checkin-snapshot';
import {readReportBrief,decodeBriefRow} from './report-brief-snapshot';
import {saveCheckin} from './checkin-store';
import {emptyCheckin} from './checkin-format';
const secret=btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+33)));
async function fixture(){
 const f=await mailFixture(),vault=await checkinVault(secret),period=reportWindow('daily',now);
 f.sqlite.exec("INSERT INTO daily_basics(owner_id,date,content) VALUES(1,'2026-11-02','private planned name'); INSERT INTO life_todos(owner_id,content,type,completed) VALUES(1,'private pending title','task',0); INSERT INTO rss_subscriptions(id,owner_id,title,category,feed_url,source_url) VALUES(1,1,'private channel alias','音乐','https://invalid.test/1','https://invalid.test/1')");
 f.sqlite.prepare("INSERT INTO rss_items(owner_id,subscription_id,external_id,title,url,published_at,created_at,discovery_kind) VALUES(1,1,'abcdefghijk','not in brief','https://invalid.test/1',0,?,'feed')").run(now.getTime()/1000-60);
 const record=emptyCheckin();record.state='confirmed';record.items=[{key:crypto.randomUUID(),kind:'habit',source:null,name:'selected check-in',result:'done',note:'',email:true,ai:true}];
 await saveCheckin(f.raw,vault,1,'2026-11-01',{value:record,baseRevision:0,clientKey:crypto.randomUUID()},now.getTime()-3600000);
 const save=()=>saveReportWithCheckins(f.raw,vault,1,period,now,undefined,{scheduledFor:now});
 return {...f,vault,period,save};
}
it('freezes encrypted names/RSS alongside the first numeric+checkin snapshot and reuses them without backfill',async()=>{
 const f=await fixture();try{
  const saved=await f.save(),brief=await readReportBrief(f.raw,f.vault,1,saved);expect(brief).not.toBeNull();expect(brief?.facts.today.priorities.items[0].name).toBe('private planned name');expect(brief?.facts.today.pending.items[0].name).toBe('private pending title');expect(brief?.rss?.updates.items).toBe(1);expect(brief?.rss?.updates.categories[0].listed[0].name).toBe('private channel alias');
  const row=f.sqlite.prepare('SELECT * FROM life_report_briefs').get(),raw=JSON.stringify(row);for(const s of ['private planned','private pending','private channel','selected check-in','not in brief'])expect(raw).not.toContain(s);
  expect(JSON.stringify(f.sqlite.prepare('SELECT snapshot_json FROM life_reports').get())).not.toContain('private');expect(f.sqlite.prepare('SELECT count(*) n FROM life_report_brief_consent').get().n).toBe(0);
  f.sqlite.exec("UPDATE daily_basics SET content='changed after capture'; UPDATE rss_subscriptions SET title='changed channel'");
  expect((await f.save()).id).toBe(saved.id);expect(f.sqlite.prepare('SELECT facts_sealed FROM life_report_briefs').get().facts_sealed).toBe(row.facts_sealed);expect((await readReportBrief(f.raw,f.vault,1,saved))?.facts.today.priorities.items[0].name).toBe('private planned name');
 }finally{f.sqlite.close();}
});
it('binds owner/report/purpose/schedule and authenticates both encrypted sections',async()=>{
 const f=await fixture();try{
  const saved=await f.save(),row=f.sqlite.prepare('SELECT * FROM life_report_briefs').get();
  await expect(readReportBrief(f.raw,f.vault,2,saved)).rejects.toThrow();await expect(f.vault.openPayload(1,'report-reading',saved.sha256,row.facts_sealed)).rejects.toThrow();await expect(f.vault.openPayload(2,'report-brief',saved.sha256,row.facts_sealed)).rejects.toThrow();
  await expect(decodeBriefRow(f.vault,1,saved,{...row,scheduled_at:row.scheduled_at+60})).rejects.toThrow();await expect(decodeBriefRow(f.vault,1,{...saved,sha256:'a'.repeat(64)},row)).rejects.toThrow();
  f.sqlite.prepare("UPDATE life_report_checkin_snapshots SET content_hmac=?").run('b'.repeat(43)+'=');await expect(readReportBrief(f.raw,f.vault,1,saved)).rejects.toThrow('binding');
 }finally{f.sqlite.close();}
});
it('commits one private brief under five competing captures and rolls all report inserts back on brief failure',async()=>{
 const f=await fixture();try{
  const saved=await Promise.all(Array.from({length:5},f.save));expect(new Set(saved.map(r=>r.id)).size).toBe(1);expect(f.sqlite.prepare('SELECT count(*) n FROM life_report_briefs').get().n).toBe(1);
 }finally{f.sqlite.close();}
 const g=await fixture();try{
  g.sqlite.exec("CREATE TRIGGER brief_abort BEFORE INSERT ON life_report_briefs BEGIN SELECT RAISE(ABORT,'synthetic brief failure'); END");await expect(g.save()).rejects.toThrow();
  expect(g.sqlite.prepare('SELECT count(*) n FROM life_reports').get().n).toBe(0);expect(g.sqlite.prepare('SELECT count(*) n FROM life_report_checkin_snapshots').get().n).toBe(0);expect(g.sqlite.prepare('SELECT count(*) n FROM life_report_briefs').get().n).toBe(0);
 }finally{g.sqlite.close();}
});
it('never attaches current named details to an old numeric report or resets prior outbound state',async()=>{
 const f=await fixture();try{
  const old=await saveReportSnapshot(f.raw,1,await previewLifeReport(f.raw,1,'daily',now));expect((await f.save()).id).toBe(old.id);expect(await readReportBrief(f.raw,f.vault,1,old)).toBeNull();
  expect(f.sqlite.prepare('SELECT count(*) n FROM life_report_mail_deliveries').get().n).toBe(0);expect(f.sqlite.prepare('SELECT count(*) n FROM life_report_ai_reservations').get().n).toBe(0);
 }finally{f.sqlite.close();}
});
it('keeps named plan snapshots fixed but exposes selected-checkin withdrawal through its independent source guard',async()=>{
 const f=await fixture();try{
  const saved=await f.save();expect((await readReportCheckins(f.raw,f.vault,1,saved))?.current).toBe(true);
  await saveCheckin(f.raw,f.vault,1,'2026-11-01',{value:emptyCheckin(),baseRevision:1,clientKey:crypto.randomUUID()},now.getTime()+1000);
  expect((await readReportCheckins(f.raw,f.vault,1,saved))?.current).toBe(false);expect((await readReportBrief(f.raw,f.vault,1,saved))?.facts.today.priorities.items[0].name).toBe('private planned name');
 }finally{f.sqlite.close();}
});
it('exposes the immutable preview only to its owner, with no source or cryptographic admission proof',async()=>{
 const f=await fixture();try{
  const saved=await f.save(),db=drizzle(f.raw,{schema}),env={DB:f.raw,LIFE_CHECKIN_KEY:secret,JWT_SECRET:'synthetic-brief-signing-key-32chars',RIN_GITHUB_CLIENT_ID:'fixture',RIN_GITHUB_CLIENT_SECRET:'fixture'} as any;
  const service=runRequestContext(env,db,()=>LifeReportsService());
  const get=async(owner:number|null)=>{const headers:Record<string,string>={};if(owner)headers.Authorization='Bearer '+await new SignJWT({id:owner}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));return runRequestContext(env,db,()=>service.handle(new Request('https://fixture.invalid/life/reports/history/'+saved.id+'/brief',{headers})));};
  expect((await get(null)).status).toBe(403);expect((await get(3)).status).toBe(403);expect((await get(2)).status).toBe(404);
  const ok=await get(1);expect(ok.status).toBe(200);expect(ok.headers.get('cache-control')).toContain('no-store');const body=await ok.json() as any;expect(body.details.previewOnly).toBe(true);expect(body.details.sourcesCurrent).toBe(true);expect(body.details.preview.text).toContain('private planned name');expect(JSON.stringify(body)).not.toContain('Hmac');expect(JSON.stringify(body)).not.toContain('hmac');expect(JSON.stringify(body)).not.toContain('sources":');
  env.LIFE_CHECKIN_KEY=undefined;expect((await get(1)).status).toBe(503);expect(f.sqlite.prepare('SELECT count(*) n FROM life_report_mail_deliveries').get().n).toBe(0);
 }finally{f.sqlite.close();}
});
it('exports a portable read-only brief in the same v5 HTTP snapshot without grants, ciphertext, or operational rows',async()=>{
 const f=await fixture();try{
  await f.save();const db=drizzle(f.raw,{schema}),env={DB:f.raw,LIFE_CHECKIN_KEY:secret,JWT_SECRET:'synthetic-brief-backup-key-32chars',RIN_GITHUB_CLIENT_ID:'fixture',RIN_GITHUB_CLIENT_SECRET:'fixture'} as any;
  const token=await new SignJWT({id:1}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET)),service=runRequestContext(env,db,()=>LifeBackupService());
  const get=(version:string)=>runRequestContext(env,db,()=>service.handle(new Request('https://fixture.invalid/life/backup?version='+version,{headers:{Authorization:'Bearer '+token}})));
  const response=await get('5');expect(response.status).toBe(200);const backup=await validateBackup(await response.json(),1),archive=backup.data.lifeReportBriefArchives[0] as any;
  expect(archive.archive.archiveOnly).toBe(true);expect(archive.archive.facts.today.priorities.items[0].name).toBe('private planned name');
  for(const field of ['content_hmac','contentHmac','facts_sealed','factsSealed','claimToken','outboundEligible','life_report_brief_consent','rss_daily_cycles'])expect(JSON.stringify(backup)).not.toContain(field);
  const wrapped=await encryptBackup(backup,'synthetic-brief-backup-passphrase');expect((await decryptBackup(wrapped,'synthetic-brief-backup-passphrase',1)).data.lifeReportBriefArchives).toEqual(backup.data.lifeReportBriefArchives);
  const forged=structuredClone(backup);(forged.data.lifeReportBriefArchives[0] as any).archive.outboundEligible=true;forged.sha256=await reportDigest(JSON.stringify(forged.data));await expect(validateBackup(forged,1)).rejects.toThrow();
  env.LIFE_CHECKIN_KEY=undefined;expect((await get('5')).status).toBe(503);expect((await get('4')).status).toBe(200);
 }finally{f.sqlite.close();}
});
