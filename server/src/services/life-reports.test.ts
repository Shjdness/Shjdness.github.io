import 'reflect-metadata';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {drizzle} from 'drizzle-orm/d1';
import {SignJWT} from 'jose';
import {expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import {runRequestContext} from '../utils/di';
import {LifeReportsService,previewLifeReport,reportQueries} from './life-reports';
import {reportWindow} from '../utils/life-report';
import {saveReportSnapshot} from '../utils/report-history';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');

function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  const folder=new URL('../../sql/',import.meta.url);
  for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort()){
    sqlite.exec(readFileSync(new URL(file,folder),'utf8'));
    if(file==='0002.sql')sqlite.exec('ALTER TABLE feeds ADD COLUMN top INTEGER DEFAULT 0');
  }
  sqlite.exec("INSERT INTO users(id,username,openid,permission) VALUES(1,'owner-a','a',1),(2,'owner-b','b',1),(3,'trusted','c',2),(4,'member','d',0)");
  const prepare=(sql:string)=>{
    let args:unknown[]=[];
    return {bind(...values:unknown[]){args=values;return this;},async all(){return {success:true,results:sqlite.prepare(sql).all(...args),meta:{}};},async raw(){return sqlite.prepare(sql).all(...args).map((row:Record<string,unknown>)=>Object.values(row));}};
  };
  const batch=vi.fn(async(statements:Array<{all:()=>Promise<unknown>}>)=>{
    sqlite.exec('BEGIN');
    try{const rows=await Promise.all(statements.map(statement=>statement.all()));sqlite.exec('COMMIT');return rows;}
    catch(error){sqlite.exec('ROLLBACK');throw error;}
  });
  const raw={prepare,batch} as any,db=drizzle(raw,{schema});
  const env={DB:raw,JWT_SECRET:'fixture-report-signing-key-with-32-characters',RIN_GITHUB_CLIENT_ID:'fixture',RIN_GITHUB_CLIENT_SECRET:'fixture'} as any;
  const service=runRequestContext(env,db,()=>LifeReportsService());
  const request=async(id:number|undefined,path:string,body?:unknown)=>{
    const headers:Record<string,string>={};
    if(id)headers.Authorization='Bearer '+await new SignJWT({id}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));
    if(body!==undefined)headers['Content-Type']='application/json';
    return await runRequestContext(env,db,()=>service.handle(new Request('http://localhost/life/reports'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)}))) as Omit<Response,'json'>&{json:()=>Promise<any>};
  };
  return {sqlite,raw,db,env,batch,request};
}

it('protects all report history/settings/status routes and discloses only secret presence to the owner',async()=>{
  const f=fixture();try{
    const patch={dailyTime:'09:00',weeklyTime:'09:30',weeklyDay:1,baseRevision:0};
    for(const owner of [undefined,3,4])for(const [path,body] of [['/status',undefined],['/settings',undefined],['/settings',patch],['/history',undefined],['/history',{kind:'daily'}],['/history/1',undefined],['/history/1/analysis',undefined],['/history/1/analysis',{allowNumericAnalysis:true}]] as const){
      const result=await f.request(owner,path,body);expect(result.status).toBe(403);expect(result.headers.get('cache-control')).toContain('no-store');
    }
    expect(f.batch).not.toHaveBeenCalled();
    f.env.DEEPSEEK_API_KEY='synthetic-private-key-never-disclosed';
    const status=await f.request(1,'/status');expect(status.status).toBe(200);
    const text=await status.text();expect(text).not.toContain(f.env.DEEPSEEK_API_KEY);
    expect(JSON.parse(text)).toMatchObject({ownerId:1,deepseekConfigured:true,apiVerified:false,aiEnabled:false,emailEnabled:false,monthlyBudgetFen:1000});
  }finally{f.sqlite.close();}
});

it('saves only server-generated facts once per complete period and keeps history owner-scoped',async()=>{
  const f=fixture();try{
    const first=await (await f.request(1,'/history',{kind:'daily'})).json();
    expect(first).toMatchObject({saved:true,created:true,ownerId:1});
    f.sqlite.exec("INSERT INTO life_todos(owner_id,content,type,completed,completed_at) VALUES(1,'new later fixture','success',1,unixepoch()-86400)");
    const retry=await (await f.request(1,'/history',{kind:'daily'})).json();
    expect(retry).toMatchObject({saved:true,created:false,id:first.id,sha256:first.sha256,report:first.report});
    expect((await f.request(2,'/history/'+first.id)).status).toBe(404);
    expect(await (await f.request(2,'/history')).json()).toMatchObject({ownerId:2,items:[]});
    expect(await (await f.request(1,'/history/'+first.id)).json()).toMatchObject({ownerId:1,id:first.id,report:first.report});
    const list=await (await f.request(1,'/history')).json();expect(list.items).toHaveLength(1);expect(list.items[0]).not.toHaveProperty('snapshot_json');
    const query=f.sqlite.prepare('EXPLAIN QUERY PLAN SELECT id FROM life_reports WHERE owner_id=? AND id<? ORDER BY id DESC LIMIT 21').all(1,Number.MAX_SAFE_INTEGER).map((r:any)=>r.detail).join(' ');
    expect(query).toContain('life_reports_owner_id');
    expect(f.sqlite.prepare("SELECT reserved FROM rss_write_budget WHERE day LIKE 'reports:%'").get()).toMatchObject({reserved:8});
  }finally{f.sqlite.close();}
});

it('uses revision-aware preferences, does not rewrite retries or enable external activity, and pauses writes on budget exhaustion',async()=>{
  const f=fixture();try{
    const original=await (await f.request(1,'/settings')).json();expect(original.preferences.revision).toBe(0);
    const patch={dailyTime:'09:00',weeklyTime:'10:00',weeklyDay:2,baseRevision:0};
    const changed=await (await f.request(1,'/settings',patch)).json();expect(changed).toMatchObject({saved:true,preferences:{revision:1,dailyTime:'09:00'}});
    const retry=await (await f.request(1,'/settings',patch)).json();expect(retry.preferences.revision).toBe(1);
    const stale=await f.request(1,'/settings',{...patch,dailyTime:'11:00'});expect(stale.status).toBe(409);
    expect((await stale.json()).preferences.dailyTime).toBe('09:00');
    expect((await f.request(1,'/settings',{...patch,dailyTime:'29:00',baseRevision:1})).status).toBe(422);
    expect(f.sqlite.prepare('SELECT email_enabled,ai_enabled,daily_enabled,weekly_enabled FROM life_report_preferences WHERE owner_id=1').get()).toMatchObject({email_enabled:0,ai_enabled:0,daily_enabled:0,weekly_enabled:0});
    expect((await (await f.request(2,'/settings')).json()).preferences.revision).toBe(0);
    f.sqlite.exec("UPDATE rss_write_budget SET reserved=2000 WHERE day LIKE 'reports:%'");
    const paused=await f.request(1,'/settings',{...patch,dailyTime:'11:00',baseRevision:1});expect(paused.status).toBe(503);expect((await paused.json()).paused).toBe(true);
    expect((await f.request(2,'/history',{kind:'daily'})).status).toBe(503);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_reports').get()).toMatchObject({n:0});
  }finally{f.sqlite.close();}
});

it('paginates history with an owner index and no duplicate or other-owner rows',async()=>{
  const f=fixture();try{
    for(let day=0;day<22;day++){
      const now=new Date(Date.UTC(2026,10,1-day));
      await saveReportSnapshot(f.raw,1,await previewLifeReport(f.raw,1,'daily',now));
    }
    await saveReportSnapshot(f.raw,2,await previewLifeReport(f.raw,2,'daily',new Date('2026-11-01T00:00:00Z')));
    const first=await (await f.request(1,'/history')).json();expect(first.items).toHaveLength(20);expect(first.nextBefore).not.toBeNull();
    const second=await (await f.request(1,'/history?before='+first.nextBefore)).json();expect(second.items).toHaveLength(2);expect(second.nextBefore).toBeNull();
    expect(new Set([...first.items,...second.items].map((r:any)=>r.id)).size).toBe(22);
    expect((await f.request(1,'/history?before=9999999999999999')).status).toBe(400);
  }finally{f.sqlite.close();}
});

it('allows one of two competing settings changes and rejects the stale one without silently replacing it',async()=>{
  const f=fixture();try{
    const patch={dailyTime:'12:00',weeklyTime:'10:00',weeklyDay:3,baseRevision:0};
    const replies=await Promise.all([f.request(1,'/settings',patch),f.request(1,'/settings',{...patch,dailyTime:'13:00'})]);
    expect(replies.map(r=>r.status).sort()).toEqual([200,409]);
    const current=await (await f.request(1,'/settings')).json();expect(current.preferences.revision).toBe(1);
    const successful=await replies.find(r=>r.status===200)!.json();expect(current.preferences).toEqual(successful.preferences);
  }finally{f.sqlite.close();}
});

it('aggregates a transaction snapshot with owner/date boundaries and indexed owner searches',async()=>{
  const f=fixture();
  try{
    const now=new Date('2026-11-02T00:00:00Z'),period=reportWindow('daily',now);
    const start=Date.parse(period.start)/1000,end=Date.parse(period.end)/1000;
    const add=f.sqlite.prepare('INSERT INTO life_todos(owner_id,content,type,completed,completed_at,created_at) VALUES(?,?,?,?,?,?)');
    for(const [owner,type,completed,at] of [[1,'task',1,start],[1,'success',1,start],[1,'daily',1,start],[2,'task',1,start],[1,'task',1,end],[1,'learn',0,start]] as const)add.run(owner,'private fixture',type,completed,at,at);
    const session=f.sqlite.prepare('INSERT INTO pomodoro_sessions(owner_id,started_at,ended_at,focus_minutes,completed,completed_early) VALUES(?,?,?,?,?,?)');
    session.run(1,start-420,start,7,1,1);session.run(2,start-1500,start,25,1,0);session.run(1,end-1500,end,25,1,0);session.run(1,start,start+1500,25,0,0);
    f.sqlite.exec("INSERT INTO habits(id,owner_id,name) VALUES(1,1,'fixture'),(2,2,'other'); INSERT INTO habit_logs(owner_id,habit_id,date) VALUES(1,1,'2026-11-01'),(2,2,'2026-11-01'); INSERT INTO life_daily_notes(owner_id,date,content) VALUES(1,'2026-11-01','private diary'),(2,'2026-11-01','other private diary')");
    const report=await previewLifeReport(f.raw,1,'daily',now);
    expect(report).toMatchObject({achievementsRecorded:2,tasksCompleted:1,ideasCreated:1,focus:{completedSessions:1,recordedMinutes:7,earlySessions:1},habitCompletions:1,daysWithNotes:1,aiEnabled:false,emailEnabled:false});
    expect(JSON.stringify(report)).not.toContain('private');
    expect(f.batch).toHaveBeenCalledOnce();
    for(const query of reportQueries(1,period)){
      const plan=f.sqlite.prepare('EXPLAIN QUERY PLAN '+query.sql).all(...query.args).map((row:any)=>row.detail).join(' ');
      expect(plan).toMatch(/SEARCH .*owner/i);
      expect(plan).not.toMatch(/SCAN (life_todos|pomodoro_sessions|habit_logs|life_daily_notes)/i);
    }
    f.sqlite.prepare('UPDATE life_daily_notes SET content=? WHERE owner_id=1').run('\t\n\u2003\uFEFF');
    expect((await previewLifeReport(f.raw,1,'daily',now)).daysWithNotes).toBe(0);
    expect((await previewLifeReport(f.raw,4,'weekly',now)).achievementsRecorded).toBe(0);
  }finally{f.sqlite.close();}
});

it('denies anonymous/member/trusted requests, scopes owner identities, and marks previews no-store',async()=>{
  const f=fixture();
  try{
    const service=runRequestContext(f.env,f.db,()=>LifeReportsService());
    const token=async(id:number)=>new SignJWT({id}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(f.env.JWT_SECRET));
    const get=async(id?:number,query='')=>{
      const headers=id?{Authorization:'Bearer '+await token(id)}:undefined;
      return runRequestContext(f.env,f.db,()=>service.handle(new Request('http://localhost/life/reports/preview'+query,{headers})));
    };
    for(const id of [undefined,3,4]){const response=await get(id);expect(response.status).toBe(403);expect(response.headers.get('cache-control')).toContain('no-store');}
    expect(f.batch).not.toHaveBeenCalled();
    for(const id of [1,2]){const response=await get(id,'?kind=weekly');expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('private');expect(await response.json()).toMatchObject({ownerId:id,period:{kind:'weekly'}});}
    expect((await get(1,'?kind=invalid')).status).toBe(422);
  }finally{f.sqlite.close();}
});


it('requires explicit numeric consent, scopes analysis to saved owner reports and never repeats a paid call',async()=>{
  const f=fixture();const provider=vi.fn(async(_url:string,_init:RequestInit)=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:'合成数字分析。',observations:[],actions:[]})}}]}));
  vi.stubGlobal('fetch',provider);
  try{
    f.env.DEEPSEEK_API_KEY='synthetic-key-only';
    const saved=await saveReportSnapshot(f.raw,1,await previewLifeReport(f.raw,1,'daily'));
    expect((await f.request(2,`/history/${saved.id}/analysis`)).status).toBe(404);
    expect((await f.request(2,`/history/${saved.id}/analysis`,{allowNumericAnalysis:true})).status).toBe(404);
    expect((await f.request(1,`/history/${saved.id}/analysis`,{})).status).toBe(422);
    expect((await f.request(1,`/history/${saved.id}/analysis`,{allowNumericAnalysis:true,diaryBody:'forbidden fixture'})).status).toBe(422);
    expect(await (await f.request(1,`/history/${saved.id}/analysis`)).json()).toMatchObject({ownerId:1,reportId:saved.id,state:'none'});
    const generated=await f.request(1,`/history/${saved.id}/analysis`,{allowNumericAnalysis:true});expect(generated.status).toBe(200);
    expect(await generated.json()).toMatchObject({ownerId:1,reportId:saved.id,state:'succeeded',analysis:{summary:'合成数字分析。'}});
    const again=await f.request(1,`/history/${saved.id}/analysis`,{allowNumericAnalysis:true});expect((await again.json()).state).toBe('succeeded');
    expect(provider).toHaveBeenCalledOnce();
    const body=JSON.parse(provider.mock.calls[0][1].body as string);
    expect(Object.values(JSON.parse(body.messages[1].content)).every(Number.isSafeInteger)).toBe(true);
    const status=await (await f.request(1,'/status')).json();expect(status).toMatchObject({reservedMonthlyFen:5,aiEnabled:false,emailEnabled:false});
  }finally{vi.unstubAllGlobals();f.sqlite.close();}
});
