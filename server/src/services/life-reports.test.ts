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
  return {sqlite,raw,db,env,batch};
}

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
