import 'reflect-metadata';
import {expect,it} from 'vitest';
import {drizzle} from 'drizzle-orm/d1';
import {SignJWT} from 'jose';
import * as schema from '../db/schema';
import {mailFixture,now} from './report-mail-fixture';
import {checkinVault} from './checkin-vault';
import {emptyCheckin} from './checkin-format';
import {saveCheckin} from './checkin-store';
import {reportWindow} from './life-report';
import {previewLifeReport} from './report-data';
import {saveReportSnapshot} from './report-history';
import {reportAIRequestKey,reportDigest} from './report-analysis-format';
import {saveReportWithCheckins,readReportCheckins} from './report-checkin-snapshot';
import {reportCheckinsValue,archiveReportCheckins} from './report-checkin-format';
import {runReportSchedule} from './report-jobs';
import {generateReportAnalysis,readReportAnalysis} from './report-analysis';
import {runRequestContext} from './di';
import {LifeBackupService} from '../services/life-backup';
import {LifeReportsService} from '../services/life-reports';
import {validateBackup,encryptBackup,decryptBackup} from '../../../client/src/features/life/backup-format';
const secret=btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+33)));
const period=()=>reportWindow('daily',now),before=new Date(now.getTime()-3600000);
async function seeded(){const f=await mailFixture(),vault=await checkinVault(secret),record=emptyCheckin();record.state='confirmed';record.items=[{key:crypto.randomUUID(),kind:'habit',source:null,name:'selected fixture',result:'unrecorded',note:'visible fixture',email:true,ai:true},{key:crypto.randomUUID(),kind:'checkin',source:null,name:'never selected secret fixture',result:'done',note:'private source body',email:false,ai:false}];record.meals=[{key:crypto.randomUUID(),kind:'plan',description:'selected recipe fixture',portion:'',email:true,ai:false}];await saveCheckin(f.raw,vault,1,'2026-11-01',{value:record,baseRevision:0,clientKey:crypto.randomUUID()},before.getTime());f.sqlite.prepare('INSERT INTO life_daily_notes(owner_id,date,content) VALUES(1,?,?)').run('2026-11-01','never include diary body');return {...f,vault,record};}

it('freezes one combined numeric/selected snapshot, authenticates bindings and never backfills old reports',async()=>{
 const f=await seeded();try{
  const saved=await saveReportWithCheckins(f.raw,f.vault,1,period(),now),view=await readReportCheckins(f.raw,f.vault,1,saved);expect(view?.current).toBe(true);expect(saved.report.daysWithNotes).toBe(1);
  const text=JSON.stringify(view?.snapshot);expect(text).toContain('selected fixture');for(const forbidden of ['never selected secret fixture','private source body','never include diary body'])expect(text).not.toContain(forbidden);
  const sealed=f.sqlite.prepare('SELECT * FROM life_report_checkin_snapshots').get();expect(sealed.sealed_json).not.toContain('selected fixture');
  await expect(readReportCheckins(f.raw,f.vault,2,saved)).rejects.toThrow();
  await expect(f.vault.openPayload(2,'report-snapshot',saved.sha256,sealed.sealed_json)).rejects.toThrow();await expect(f.vault.openPayload(1,'report-mail',saved.sha256,sealed.sealed_json)).rejects.toThrow();
  const wrongHash={...saved,sha256:'a'.repeat(64)};await expect(readReportCheckins(f.raw,f.vault,1,wrongHash)).rejects.toThrow();
  f.record.items[0].note='edited later';await saveCheckin(f.raw,f.vault,1,'2026-11-01',{value:f.record,baseRevision:1,clientKey:crypto.randomUUID()},now.getTime()+1000);
  const again=await saveReportWithCheckins(f.raw,f.vault,1,period(),new Date(now.getTime()+2000));expect(again.id).toBe(saved.id);expect(f.sqlite.prepare('SELECT sealed_json FROM life_report_checkin_snapshots').get().sealed_json).toBe(sealed.sealed_json);expect((await readReportCheckins(f.raw,f.vault,1,saved))?.current).toBe(false);
  const otherPeriod=reportWindow('daily',new Date(now.getTime()-86400000));const old=await saveReportSnapshot(f.raw,1,await previewLifeReport(f.raw,1,'daily',new Date(now.getTime()-86400000)));const preserved=await saveReportWithCheckins(f.raw,f.vault,1,otherPeriod,now);expect(preserved.id).toBe(old.id);expect(await readReportCheckins(f.raw,f.vault,1,old)).toBeNull();
 }finally{f.sqlite.close();}
});
it('rolls back both report records on extension failure and rejects sources changed during capture',async()=>{
 const f=await seeded();try{
  f.sqlite.exec("CREATE TRIGGER fail_extension BEFORE INSERT ON life_report_checkin_snapshots BEGIN SELECT RAISE(ABORT,'fixture failure'); END");await expect(saveReportWithCheckins(f.raw,f.vault,1,period(),now)).rejects.toThrow();expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_reports').get().n).toBe(0);f.sqlite.exec('DROP TRIGGER fail_extension');
  let changed=false;const intercepted={...f.raw,batch:async(statements:unknown[])=>{const result=await f.raw.batch(statements);if(!changed&&statements.length===8){changed=true;f.record.items[0].email=false;await saveCheckin(f.raw,f.vault,1,'2026-11-01',{value:f.record,baseRevision:1,clientKey:crypto.randomUUID()},now.getTime());}return result;}};
  await expect(saveReportWithCheckins(intercepted,f.vault,1,period(),now)).rejects.toThrow();expect(changed).toBe(true);expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_reports').get().n).toBe(0);expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_checkin_snapshots').get().n).toBe(0);
 }finally{f.sqlite.close();}
});
it('handles concurrent generation once, invalidates new/missing/withdrawn source proofs and keeps prior unknown AI untouched',async()=>{
 const f=await seeded();try{
  const results=await Promise.all(Array.from({length:5},()=>saveReportWithCheckins(f.raw,f.vault,1,period(),now)));expect(new Set(results.map(r=>r.id)).size).toBe(1);expect(results.filter(r=>r.created).length).toBe(1);expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_checkin_snapshots').get().n).toBe(1);
  const saved=results[0],key=await reportAIRequestKey({id:saved.id,ownerId:1,sha256:saved.sha256});f.sqlite.prepare("INSERT INTO life_report_analyses(request_key,owner_id,report_id,snapshot_sha256,model,prompt_version,state,reason,created_at,updated_at) VALUES(?,1,?,?,'deepseek-flash',1,'unknown','unavailable',?,?)").run(key,saved.id,saved.sha256,now.getTime()/1000,now.getTime()/1000);f.sqlite.exec("INSERT INTO life_report_ai_budget VALUES('2026-11',5)");
  await saveCheckin(f.raw,f.vault,1,'2026-10-31',{value:emptyCheckin(),baseRevision:0,clientKey:crypto.randomUUID()},before.getTime());expect((await readReportCheckins(f.raw,f.vault,1,saved))?.current).toBe(false);
  await saveReportWithCheckins(f.raw,f.vault,1,period(),now);expect(f.sqlite.prepare('SELECT state FROM life_report_analyses').get().state).toBe('unknown');expect(f.sqlite.prepare('SELECT reserved_fen FROM life_report_ai_budget').get().reserved_fen).toBe(5);
 }finally{f.sqlite.close();}
});
it('stores only selected current task labels, and the real scheduler captures weekly and daily extensions without calling external providers',async()=>{
 const f=await seeded();try{
  f.sqlite.exec("INSERT INTO life_todos(id,owner_id,content,type,deadline_at) VALUES(51,1,'new raw title must not leak','task',1793550000),(52,1,'unselected pending title','task',1793550000),(53,2,'another owner title','task',1793550000)");f.record.items.push({key:crypto.randomUUID(),kind:'checkin',source:{kind:'todo',id:51},name:'chosen historical task name',result:'missed',note:'',email:true,ai:false});await saveCheckin(f.raw,f.vault,1,'2026-11-01',{value:f.record,baseRevision:1,clientKey:crypto.randomUUID()},before.getTime());
  const done=await runReportSchedule(f.raw,now,{checkins:f.vault});expect(done.processed).toBe(1);expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_checkin_snapshots').get().n).toBe(2);expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_mail_deliveries').get().n).toBe(0);expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_ai_reservations').get().n).toBe(0);
  const saved=await saveReportWithCheckins(f.raw,f.vault,1,period(),now),view=await readReportCheckins(f.raw,f.vault,1,saved);expect(view?.snapshot.current).toMatchObject({pendingTasks:2,todos:[{id:51,name:'chosen historical task name'}]});expect(JSON.stringify(view)).not.toContain('new raw title must not leak');expect(JSON.stringify(view)).not.toContain('another owner title');
 }finally{f.sqlite.close();}
});
it('exports rich history as read-only portable archives and restores it with no external admission proof',async()=>{
 const f=await seeded();try{
  const saved=await saveReportWithCheckins(f.raw,f.vault,1,period(),now),db=drizzle(f.raw,{schema}),env={DB:f.raw,LIFE_CHECKIN_KEY:secret,JWT_SECRET:'synthetic-signing-secret-only-32-chars',RIN_GITHUB_CLIENT_ID:'fixture',RIN_GITHUB_CLIENT_SECRET:'fixture'} as any;
  const jwt=await new SignJWT({id:1}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));const api=runRequestContext(env,db,()=>LifeBackupService());
  const response=await runRequestContext(env,db,()=>api.handle(new Request('https://fixture.invalid/life/backup?version=5',{headers:{Authorization:'Bearer '+jwt}})));expect(response.status,await response.clone().text()).toBe(200);const backup=await validateBackup(await response.json(),1);expect(backup.data.lifeReportCheckinArchives).toHaveLength(1);
  const encrypted=await encryptBackup(backup,'synthetic-archive-backup-password'),decoded=await decryptBackup(encrypted,'synthetic-archive-backup-password',1),r=decoded.data.lifeReportCheckinArchives[0] as any;expect(r.archive.archiveOnly).toBe(true);expect(r.archive.sources).toBeUndefined();expect(JSON.stringify(r)).not.toContain('content_hmac');
  const restored=await mailFixture();try{
   const parent=await saveReportSnapshot(restored.raw,1,saved.report),newVault=await checkinVault(btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+81))));const sealed=await newVault.sealPayload(1,'report-snapshot',parent.sha256,r.archive),hmac=await newVault.payloadDigest(1,'report-snapshot',parent.sha256,r.archive);
   restored.sqlite.prepare('INSERT INTO life_report_checkin_snapshots(report_id,owner_id,report_sha256,version,sealed_json,content_hmac,created_at) VALUES(?,1,?,1,?,?,?)').run(parent.id,parent.sha256,sealed,hmac,now.getTime()/1000);expect((await readReportCheckins(restored.raw,newVault,1,parent))?.current).toBe(false);
   restored.sqlite.exec('UPDATE life_report_checkin_snapshots SET outbound_eligible=1');await expect(readReportCheckins(restored.raw,newVault,1,parent)).rejects.toThrow();
  }finally{restored.sqlite.close();}
  const changed=structuredClone(backup);(changed.data.lifeReportCheckinArchives[0] as any).archive.sources=[];changed.sha256=await reportDigest(JSON.stringify(changed.data));await expect(validateBackup(changed,1)).rejects.toThrow();
  const view=await readReportCheckins(f.raw,f.vault,1,saved);if(!view||!('sources' in view.snapshot))throw Error();const archive=archiveReportCheckins(view.snapshot,saved.report);expect(()=>reportCheckinsValue(archive,saved.report)).toThrow();
 }finally{f.sqlite.close();}
});
it('exposes frozen details only to the report owner, and missing keys or old reports fail safely',async()=>{
 const f=await seeded();try{const saved=await saveReportWithCheckins(f.raw,f.vault,1,period(),now),db=drizzle(f.raw,{schema}),env={DB:f.raw,LIFE_CHECKIN_KEY:secret,JWT_SECRET:'synthetic-details-signing-key-32chars',RIN_GITHUB_CLIENT_ID:'fixture',RIN_GITHUB_CLIENT_SECRET:'fixture'} as any,api=runRequestContext(env,db,()=>LifeReportsService());
  const get=async(owner:number|null)=>{const headers:Record<string,string>={};if(owner)headers.Authorization='Bearer '+await new SignJWT({id:owner}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));return runRequestContext(env,db,()=>api.handle(new Request('https://fixture.invalid/life/reports/history/'+saved.id+'/checkins',{headers})));};
  expect((await get(null)).status).toBe(403);expect((await get(3)).status).toBe(403);expect((await get(2)).status).toBe(404);const ok=await get(1);expect(ok.status).toBe(200);expect(ok.headers.get('cache-control')).toContain('no-store');const body=await ok.json() as any;expect(body.details.current).toBe(true);expect(body.details.snapshot.sources).toBeUndefined();expect(JSON.stringify(body)).not.toContain('hmac');env.LIFE_CHECKIN_KEY=undefined;expect((await get(1)).status).toBe(503);
 }finally{f.sqlite.close();}
});
it('does not treat old numeric AI consent as approval for a rich report or reserve money',async()=>{
 const f=await seeded();try{const saved=await saveReportWithCheckins(f.raw,f.vault,1,period(),now);let calls=0;const fetcher=async()=>{calls++;throw Error('must not call provider');};expect(await readReportAnalysis(f.raw,1,saved,now)).toMatchObject({state:'none',reason:'checkin-scope-required'});expect(await generateReportAnalysis({db:f.raw,ownerId:1,saved,enabled:true,apiKey:'synthetic-never-sent',fetcher,now})).toMatchObject({reason:'checkin-scope-required'});expect(calls).toBe(0);expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_ai_reservations').get().n).toBe(0);expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_analyses').get().n).toBe(0);
 }finally{f.sqlite.close();}
});
