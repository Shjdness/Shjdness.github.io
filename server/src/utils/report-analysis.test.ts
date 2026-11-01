import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {saveReportSnapshot} from './report-history';
import {reportWindow,type LifeReportPreview} from './life-report';
import {generateReportAnalysis,readReportAnalysis} from './report-analysis';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
const now=new Date('2026-11-02T00:00:00Z');
const sample=(ownerId=1):LifeReportPreview=>({version:1,ownerId,generatedAt:now.toISOString(),period:reportWindow('daily',now),coverage:'server-synced-only',mode:'statistics-preview',achievementsRecorded:2,tasksCompleted:1,ideasCreated:0,focus:{completedSessions:1,recordedMinutes:7,earlySessions:1},habitCompletions:1,daysWithNotes:1,aiEnabled:false,emailEnabled:false});
const analysis={summary:'有一些已记录的进展。',observations:['本周期保留了成果记录。'],actions:['选择容易开始的一步。']};
const response=()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(analysis)}}]});

function database(){
  const sqlite=new DatabaseSync(':memory:'),folder=new URL('../../sql/',import.meta.url);
  for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort()){
    sqlite.exec(readFileSync(new URL(file,folder),'utf8'));if(file==='0002.sql')sqlite.exec('ALTER TABLE feeds ADD COLUMN top INTEGER DEFAULT 0');
  }
  sqlite.exec("INSERT INTO users(id,username,openid,permission) VALUES(1,'a','a',1),(2,'b','b',1)");
  let tail=Promise.resolve();
  const raw={prepare(sql:string){let values:unknown[]=[];return {bind(...args:unknown[]){values=args;return this;},async all(){return {success:true,results:sqlite.prepare(sql).all(...values),meta:{}};}};},batch(statements:Array<{all:()=>Promise<unknown>}>){
    const next=tail.then(async()=>{sqlite.exec('BEGIN');try{const rows=[];for(const statement of statements)rows.push(await statement.all());sqlite.exec('COMMIT');return rows;}catch(error){sqlite.exec('ROLLBACK');throw error;}});
    tail=next.then(()=>{},()=>{});return next;
  }} as any;
  return {sqlite,raw};
}

it('persists one result for racing calls and reuses it across month/restarts without exporting identities',async()=>{
  const db=database();try{
    const saved=await saveReportSnapshot(db.raw,1,sample()),fetcher=vi.fn(async(_url:string,_init:RequestInit)=>response());
    const options={db:db.raw,ownerId:1,saved,enabled:true,apiKey:'fixture-private-key',now,fetcher};
    const raced=await Promise.all(Array.from({length:8},()=>generateReportAnalysis(options)));
    expect(raced.some(r=>r.state==='succeeded')).toBe(true);expect(fetcher).toHaveBeenCalledOnce();
    expect(await generateReportAnalysis({...options,now:new Date('2026-12-01T00:00:00Z')})).toMatchObject({state:'succeeded',analysis});
    expect(await readReportAnalysis(db.raw,1,saved,now)).toMatchObject({state:'succeeded',analysis});
    expect(db.sqlite.prepare('SELECT reserved_fen FROM life_report_ai_budget').get()).toMatchObject({reserved_fen:5});
    const body=JSON.parse(fetcher.mock.calls[0][1].body as string);
    expect(Object.values(JSON.parse(body.messages[1].content)).every(Number.isSafeInteger)).toBe(true);
    expect(JSON.stringify(db.sqlite.prepare('SELECT * FROM life_report_analyses').all())).not.toContain('fixture-private-key');
    await expect(generateReportAnalysis({...options,ownerId:2})).rejects.toThrow('owner');
  }finally{db.sqlite.close();}
});

it('never resubmits after unknown provider outcomes or after a lost result write',async()=>{
  const db=database();try{
    const saved=await saveReportSnapshot(db.raw,1,sample()),fetcher=vi.fn(async()=>{throw Error('fixture provider failure');});
    const options={db:db.raw,ownerId:1,saved,enabled:true,apiKey:'fixture',now,fetcher};
    expect(await generateReportAnalysis(options)).toMatchObject({state:'unknown',reason:'unavailable'});
    expect(await generateReportAnalysis(options)).toMatchObject({state:'unknown'});expect(fetcher).toHaveBeenCalledOnce();
    const other=await saveReportSnapshot(db.raw,2,sample(2)),success=vi.fn(async()=>response());
    db.sqlite.exec("CREATE TRIGGER fixture_result_failure BEFORE UPDATE ON life_report_analyses WHEN NEW.owner_id=2 BEGIN SELECT RAISE(ABORT,'lost result write'); END");
    await expect(generateReportAnalysis({...options,ownerId:2,saved:other,fetcher:success})).rejects.toThrow('lost result');
    db.sqlite.exec('DROP TRIGGER fixture_result_failure');
    expect(await generateReportAnalysis({...options,ownerId:2,saved:other,fetcher:success,now:new Date(now.getTime()+61000)})).toMatchObject({state:'unknown',reason:'interrupted'});
    expect(success).toHaveBeenCalledOnce();
    expect(db.sqlite.prepare('SELECT reserved_fen FROM life_report_ai_budget').get()).toMatchObject({reserved_fen:10});
  }finally{db.sqlite.close();}
});

it('does not submit when disabled, pricing expired, budget full or snapshot is inconsistent',async()=>{
  const db=database();try{
    const saved=await saveReportSnapshot(db.raw,1,sample()),fetcher=vi.fn(async(_url:string,_init:RequestInit)=>response());
    const options={db:db.raw,ownerId:1,saved,enabled:true,apiKey:'fixture',now,fetcher};
    for(const patch of [{enabled:false},{apiKey:undefined},{now:new Date('2026-12-01T00:00:00+08:00')}])expect((await generateReportAnalysis({...options,...patch})).state).toBe('none');
    await expect(generateReportAnalysis({...options,saved:{...saved,report:{...saved.report,achievementsRecorded:100}}})).rejects.toThrow('digest');
    db.sqlite.exec("INSERT INTO life_report_ai_budget(month,reserved_fen) VALUES('2026-11',1000)");
    expect(await generateReportAnalysis(options)).toMatchObject({state:'statistics',reason:'budget-or-duplicate'});
    expect(fetcher).not.toHaveBeenCalled();
  }finally{db.sqlite.close();}
});

it('rejects corrupted or rebound stored results instead of replacing them with a paid retry',async()=>{
  const db=database();try{
    const saved=await saveReportSnapshot(db.raw,1,sample()),fetcher=vi.fn(async(_url:string,_init:RequestInit)=>response());
    const options={db:db.raw,ownerId:1,saved,enabled:true,apiKey:'fixture',now,fetcher};
    await generateReportAnalysis(options);
    db.sqlite.exec("UPDATE life_report_analyses SET analysis_json='{}'");
    await expect(generateReportAnalysis(options)).rejects.toThrow('Damaged');expect(fetcher).toHaveBeenCalledOnce();
    expect(db.sqlite.prepare('SELECT analysis_json FROM life_report_analyses').get()).toMatchObject({analysis_json:'{}'});
  }finally{db.sqlite.close();}
});
