import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {reportWindow,type LifeReportPreview} from './life-report';
import {reportSnapshot,saveReportSnapshot} from './report-history';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
const sample=():LifeReportPreview=>({version:1,ownerId:1,generatedAt:'2026-11-02T00:00:00Z',period:reportWindow('daily',new Date('2026-11-02T00:00:00Z')),coverage:'server-synced-only',mode:'statistics-preview',achievementsRecorded:2,tasksCompleted:1,ideasCreated:0,focus:{completedSessions:1,recordedMinutes:7,earlySessions:1},habitCompletions:1,daysWithNotes:1,aiEnabled:false,emailEnabled:false});

function database(){
  const sqlite=new DatabaseSync(':memory:');
  const folder=new URL('../../sql/',import.meta.url);
  for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql')&&!name.startsWith('0027')).sort()){
    sqlite.exec(readFileSync(new URL(file,folder),'utf8'));if(file==='0002.sql')sqlite.exec('ALTER TABLE feeds ADD COLUMN top INTEGER DEFAULT 0');
  }
  sqlite.exec("INSERT INTO users(id,username,openid,permission) VALUES(1,'fixture-a','a',1),(2,'fixture-b','b',1); INSERT INTO life_todos(id,owner_id,content) VALUES(91,1,'original task fixture'); INSERT INTO life_daily_notes(owner_id,date,content) VALUES(1,'2026-11-01','original note fixture')");
  sqlite.exec(readFileSync(new URL('0027-life-reports.sql',folder),'utf8'));
  let tail=Promise.resolve(),abort=false;
  const raw={prepare(sql:string){let values:unknown[]=[];return {bind(...args:unknown[]){values=args;return this;},async all(){return {success:true,results:sqlite.prepare(sql).all(...values),meta:{}};}};},batch(statements:Array<{all:()=>Promise<unknown>}>){
    const next=tail.then(async()=>{
      sqlite.exec('BEGIN');
      try{const rows=[];for(const statement of statements){rows.push(await statement.all());if(abort){abort=false;throw Error('synthetic transaction abort');}}sqlite.exec('COMMIT');return rows;}
      catch(error){sqlite.exec('ROLLBACK');throw error;}
    });tail=next.then(()=>{},()=>{});return next;
  }} as any;
  return {sqlite,raw,abortNext:()=>{abort=true;}};
}

it('adds report tables without touching old records and keeps all outbound features off by default',()=>{
  const db=database();try{
    expect(db.sqlite.prepare('SELECT id,owner_id,content FROM life_todos WHERE id=91').get()).toMatchObject({id:91,owner_id:1,content:'original task fixture'});
    expect(db.sqlite.prepare('SELECT content FROM life_daily_notes WHERE owner_id=1').get()).toMatchObject({content:'original note fixture'});
    db.sqlite.exec('INSERT INTO life_report_preferences(owner_id) VALUES(1)');
    expect(db.sqlite.prepare('SELECT * FROM life_report_preferences').get()).toMatchObject({daily_time:'08:00',weekly_time:'08:00',weekly_day:1,daily_enabled:0,weekly_enabled:0,email_enabled:0,ai_enabled:0,ai_scope:'statistics'});
    expect(()=>db.sqlite.exec("UPDATE life_report_preferences SET daily_time='29:00'")).toThrow();
    expect(()=>db.sqlite.exec("UPDATE life_report_preferences SET ai_scope='diary-body'")).toThrow();
    expect(()=>db.sqlite.exec("UPDATE life_report_preferences SET ai_scope='named'")).toThrow();
  }finally{db.sqlite.close();}
});

it('projects only known statistics and rejects wrong identities or incomplete periods before persistence',async()=>{
  const original={...sample(),secret:'must not store',period:{...sample().period,rawDiary:'must not store'}};
  expect(JSON.stringify(reportSnapshot(1,original))).not.toContain('must not store');
  expect(()=>reportSnapshot(2,original)).toThrow('owner');
  expect(()=>reportSnapshot(1,{...sample(),generatedAt:'2026-10-31T00:00:00Z'})).toThrow('period');
  expect(()=>reportSnapshot(1,{...sample(),focus:{completedSessions:1,recordedMinutes:-1,earlySessions:1}})).toThrow('facts');
  const db=database();try{
    await expect(saveReportSnapshot(db.raw,2,original)).rejects.toThrow('owner');
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM life_reports').get()).toMatchObject({n:0});
  }finally{db.sqlite.close();}
});

it('keeps the first committed snapshot during racing/retried saves and isolates owners',async()=>{
  const db=database();try{
    const original=sample(),changed={...sample(),achievementsRecorded:3,generatedAt:'2026-11-02T01:00:00Z'};
    const results=await Promise.all([saveReportSnapshot(db.raw,1,original),saveReportSnapshot(db.raw,1,changed)]);
    expect(results.filter(row=>row.created)).toHaveLength(1);expect(results[0].id).toBe(results[1].id);
    expect(results[0].sha256).toBe(results[1].sha256);expect(results[0].report).toEqual(results[1].report);
    const retry=await saveReportSnapshot(db.raw,1,changed);expect(retry.created).toBe(false);expect(retry.report).toEqual(results[0].report);
    const other=await saveReportSnapshot(db.raw,2,{...sample(),ownerId:2});expect(other.id).not.toBe(retry.id);
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM life_reports').get()).toMatchObject({n:2});
    // Isolated table-copy recovery: not the application backup/import path.
    const recovered=database();try{
      const row=db.sqlite.prepare('SELECT * FROM life_reports WHERE owner_id=1').get();
      recovered.sqlite.prepare('INSERT INTO life_reports(id,owner_id,kind,period_start,period_end,snapshot_json,snapshot_sha256,created_at) VALUES(?,?,?,?,?,?,?,?)').run(row.id,row.owner_id,row.kind,row.period_start,row.period_end,row.snapshot_json,row.snapshot_sha256,row.created_at);
      expect(await saveReportSnapshot(recovered.raw,1,changed)).toMatchObject({id:retry.id,created:false,sha256:retry.sha256,report:retry.report});
    }finally{recovered.sqlite.close();}
  }finally{db.sqlite.close();}
});

it('rolls back an interrupted save and refuses corrupted history without replacing it',async()=>{
  const db=database();try{
    db.abortNext();await expect(saveReportSnapshot(db.raw,1,sample())).rejects.toThrow('abort');
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM life_reports').get()).toMatchObject({n:0});
    expect((await saveReportSnapshot(db.raw,1,sample())).created).toBe(true);
    db.sqlite.exec("UPDATE life_reports SET snapshot_json='{}' WHERE owner_id=1");
    await expect(saveReportSnapshot(db.raw,1,sample())).rejects.toThrow('damaged');
    expect(db.sqlite.prepare('SELECT snapshot_json FROM life_reports').get()).toMatchObject({snapshot_json:'{}'});
  }finally{db.sqlite.close();}
});
