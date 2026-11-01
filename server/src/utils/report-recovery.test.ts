import 'reflect-metadata';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {BACKUP_TABLES,encryptBackup,decryptBackup,type Backup} from '../../../client/src/features/life/backup-format';
import {buildBackupEnvelope} from '../services/life-backup';
import {reportAIRequestKey,reportDigest} from './report-analysis-format';
import {reportSnapshot,reportWindow} from './life-report';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');

function targetDatabase(){
  const sqlite=new DatabaseSync(':memory:');
  const folder=new URL('../../sql/',import.meta.url);
  for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort()){
    sqlite.exec(readFileSync(new URL(file,folder),'utf8'));if(file==='0002.sql')sqlite.exec('ALTER TABLE feeds ADD COLUMN top INTEGER DEFAULT 0');
  }
  sqlite.exec("INSERT INTO users(id,username,openid,permission) VALUES(1,'fixture-owner','fixture',1),(2,'other-owner','other',1); INSERT INTO life_todos(id,owner_id,content) VALUES(91,1,'existing target task'); INSERT INTO life_daily_notes(owner_id,date,content) VALUES(1,'2026-11-01','existing target note'); INSERT INTO life_report_ai_budget(month,reserved_fen) VALUES('2026-11',995); INSERT INTO life_report_ai_reservations(request_key,month,reserved_fen) VALUES('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-11',5); INSERT INTO life_report_preferences(owner_id) VALUES(2)");
  return sqlite;
}

async function encryptedFixture(version:3|4=3){
  const data:Record<string,unknown[]>=Object.fromEntries(BACKUP_TABLES.map(name=>[name,[]]));
  const report=reportSnapshot(1,{version:1,ownerId:1,generatedAt:'2026-11-02T00:00:00Z',period:reportWindow('daily',new Date('2026-11-02T00:00:00Z')),coverage:'server-synced-only',mode:'statistics-preview',achievementsRecorded:1,tasksCompleted:1,ideasCreated:0,habitCompletions:1,daysWithNotes:1,focus:{completedSessions:1,recordedMinutes:7,earlySessions:1},aiEnabled:false,emailEnabled:false});
  const json=JSON.stringify(report),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json));
  const sha=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
  data.lifeReports=[{id:501,ownerId:1,kind:'daily',periodStart:report.period.start,periodEnd:report.period.end,timezone:'Asia/Shanghai',templateVersion:1,snapshotJson:json,snapshotSha256:sha,createdAt:'2026-11-02T00:00:00Z'}];
  // Source flags can be enabled; recovery must NOT resume external activity.
  data.lifeReportPreferences=[{ownerId:1,timezone:'Asia/Shanghai',dailyTime:'08:00',weeklyTime:'09:00',weeklyDay:1,dailyEnabled:1,weeklyEnabled:1,emailEnabled:1,aiEnabled:1,aiScope:'statistics'}];
  if(version===4){
    const result=JSON.stringify({summary:'合成成果记录。',observations:[],actions:['选择一件小事。']});
    data.lifeReportAnalyses=[{requestKey:await reportAIRequestKey({id:501,ownerId:1,sha256:sha}),ownerId:1,reportId:501,snapshotSha256:sha,model:'deepseek-flash',promptVersion:1,state:'succeeded',reason:null,analysisJson:result,analysisSha256:await reportDigest(result),createdAt:'2026-11-02T00:00:00Z',updatedAt:'2026-11-02T00:00:00Z'}];
  }
  const backup=await buildBackupEnvelope(1,data,version);
  return {encrypted:await encryptBackup(backup,'isolated-report-recovery-fixture'),report,sha};
}

/** Test-only procedure, not an exported production restore path. Start only AFTER
 * decryptBackup has verified owner, envelope and inner report snapshots. */
function restoreFixture(sqlite:any,backup:Backup){
  if(![3,4].includes(backup.version)||backup.ownerId!==1)throw Error('Fixture requires a verified owner v3 backup');
  sqlite.exec('BEGIN');
  try{
    for(const value of backup.data.lifeReports){
      const r=value as Record<string,any>;
      sqlite.prepare(`INSERT INTO life_reports(id,owner_id,kind,period_start,period_end,timezone,template_version,snapshot_json,snapshot_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(r.id,r.ownerId,r.kind,Date.parse(r.periodStart)/1000,Date.parse(r.periodEnd)/1000,r.timezone,r.templateVersion,r.snapshotJson,r.snapshotSha256,Date.parse(r.createdAt)/1000);
    }
    for(const value of backup.data.lifeReportPreferences){
      const p=value as Record<string,any>;
      sqlite.prepare(`INSERT INTO life_report_preferences(owner_id,timezone,daily_time,weekly_time,weekly_day,daily_enabled,weekly_enabled,email_enabled,ai_enabled,ai_scope) VALUES(?,?,?,?,?,0,0,0,0,?)`).run(p.ownerId,p.timezone,p.dailyTime,p.weeklyTime,p.weeklyDay,p.aiScope);
    }
    for(const value of backup.data.lifeReportAnalyses??[]){
      const a=value as Record<string,any>,pending=a.state==='pending';
      sqlite.prepare(`INSERT INTO life_report_analyses(request_key,owner_id,report_id,snapshot_sha256,model,prompt_version,state,reason,analysis_json,analysis_sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(a.requestKey,a.ownerId,a.reportId,a.snapshotSha256,a.model,a.promptVersion,pending?'unknown':a.state,pending?'interrupted':a.reason,a.analysisJson,a.analysisSha256,Date.parse(a.createdAt)/1000,Date.parse(a.updatedAt)/1000);
    }
    sqlite.exec('COMMIT');
  }catch(error){sqlite.exec('ROLLBACK');throw error;}
}

function assertUnrelatedData(sqlite:any){
  expect(sqlite.prepare('SELECT id,content FROM life_todos').all()).toEqual([expect.objectContaining({id:91,content:'existing target task'})]);
  expect(sqlite.prepare('SELECT content FROM life_daily_notes').get()).toMatchObject({content:'existing target note'});
  expect(sqlite.prepare('SELECT reserved_fen FROM life_report_ai_budget').get()).toMatchObject({reserved_fen:995});
  expect(sqlite.prepare('SELECT count(*) AS n FROM life_report_ai_reservations').get()).toMatchObject({n:1});
  expect(sqlite.prepare('SELECT owner_id FROM life_report_preferences WHERE owner_id=2').get()).toMatchObject({owner_id:2});
}

it('recovers both new report tables from a real encrypted envelope and leaves outbound features paused',async()=>{
  const source=await encryptedFixture(),target=targetDatabase();
  try{
    const file=JSON.parse(JSON.stringify(source.encrypted));
    const backup=await decryptBackup(file,'isolated-report-recovery-fixture',1);
    restoreFixture(target,backup);
    const row=target.prepare('SELECT * FROM life_reports WHERE owner_id=1').get();
    expect(row).toMatchObject({id:501,owner_id:1,snapshot_sha256:source.sha});
    expect(JSON.parse(row.snapshot_json)).toEqual(source.report);
    const prefs=target.prepare('SELECT * FROM life_report_preferences WHERE owner_id=1').get();
    expect(prefs).toMatchObject({daily_time:'08:00',weekly_time:'09:00',daily_enabled:0,weekly_enabled:0,email_enabled:0,ai_enabled:0});
    assertUnrelatedData(target);
    const before=JSON.stringify(target.prepare('SELECT * FROM life_reports').all());
    expect(()=>restoreFixture(target,backup)).toThrow();
    expect(JSON.stringify(target.prepare('SELECT * FROM life_reports').all())).toBe(before);
    assertUnrelatedData(target);
  }finally{target.close();}
});

it('refuses wrong accounts/files before restore and rolls the whole report restore back on a later write failure',async()=>{
  const source=await encryptedFixture(),target=targetDatabase();
  try{
    await expect(decryptBackup(source.encrypted,'isolated-report-recovery-fixture',2)).rejects.toThrow('账号不符');
    await expect(decryptBackup({...source.encrypted,ciphertext:source.encrypted.ciphertext.slice(4)},'isolated-report-recovery-fixture',1)).rejects.toThrow();
    expect(target.prepare('SELECT count(*) AS n FROM life_reports').get()).toMatchObject({n:0});
    const backup=await decryptBackup(source.encrypted,'isolated-report-recovery-fixture',1);
    target.exec("CREATE TRIGGER fixture_abort_report_restore BEFORE INSERT ON life_report_preferences WHEN NEW.owner_id=1 BEGIN SELECT RAISE(ABORT,'synthetic restore interruption'); END");
    expect(()=>restoreFixture(target,backup)).toThrow('interruption');
    expect(target.prepare('SELECT count(*) AS n FROM life_reports').get()).toMatchObject({n:0});
    expect(target.prepare('SELECT count(*) AS n FROM life_report_preferences WHERE owner_id=1').get()).toMatchObject({n:0});
    assertUnrelatedData(target);
    target.exec('DROP TRIGGER fixture_abort_report_restore');restoreFixture(target,backup);
    expect(target.prepare('SELECT count(*) AS n FROM life_reports').get()).toMatchObject({n:1});
    assertUnrelatedData(target);
  }finally{target.close();}
});


it('recovers encrypted v4 analysis results without changing global spend and never resumes pending calls',async()=>{
  const source=await encryptedFixture(4),target=targetDatabase();
  try{
    const backup=await decryptBackup(source.encrypted,'isolated-report-recovery-fixture',1);
    restoreFixture(target,backup);
    expect(target.prepare('SELECT state,analysis_json FROM life_report_analyses').get()).toMatchObject({state:'succeeded',analysis_json:expect.stringContaining('合成成果记录')});
    assertUnrelatedData(target);
    const pending=structuredClone(backup),a=pending.data.lifeReportAnalyses[0] as Record<string,any>;
    a.state='pending';a.reason=null;a.analysisJson=null;a.analysisSha256=null;
    const clean=targetDatabase();
    try{pending.sha256=await reportDigest(JSON.stringify(pending.data));const pendingFile=await encryptBackup(pending,'isolated-pending-v4-passphrase');const checked=await decryptBackup(pendingFile,'isolated-pending-v4-passphrase',1);restoreFixture(clean,checked);expect(clean.prepare('SELECT state,reason FROM life_report_analyses').get()).toMatchObject({state:'unknown',reason:'interrupted'});assertUnrelatedData(clean);}finally{clean.close();}
    const interrupted=targetDatabase();
    try{
      interrupted.exec("CREATE TRIGGER fixture_analysis_abort BEFORE INSERT ON life_report_analyses BEGIN SELECT RAISE(ABORT,'analysis restore failure'); END");
      expect(()=>restoreFixture(interrupted,backup)).toThrow('analysis restore failure');
      expect(interrupted.prepare('SELECT count(*) AS n FROM life_reports').get()).toMatchObject({n:0});assertUnrelatedData(interrupted);
    }finally{interrupted.close();}
  }finally{target.close();}
});
