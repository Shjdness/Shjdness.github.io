import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {readBriefFacts,briefFactsValue,briefFactQueries,type BriefContext} from './report-brief-data';
import {reportWindow} from './life-report';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
const context=(kind:'daily'|'weekly'='daily'):BriefContext=>({owner:1,period:reportWindow(kind,new Date('2026-11-04T00:00:00Z')),capturedAt:new Date('2026-11-03T21:00:00Z'),scheduledFor:new Date('2026-11-04T00:00:00Z')});
function fixture(){
 const sqlite=new DatabaseSync(':memory:'),folder=new URL('../../sql/',import.meta.url);
 for(const file of readdirSync(folder).filter(s=>s.endsWith('.sql')).sort()){sqlite.exec(readFileSync(new URL(file,folder),'utf8'));if(file==='0002.sql')sqlite.exec('ALTER TABLE feeds ADD COLUMN top INTEGER DEFAULT 0');}
 sqlite.exec("INSERT INTO users(id,username,openid,permission) VALUES(1,'a','a',1),(2,'b','b',1); INSERT INTO habits(id,owner_id,name,active) VALUES(1,1,'练琴',1),(2,1,'未记录的习惯',1),(3,2,'另一账号的习惯',1); INSERT INTO habit_logs(owner_id,habit_id,date,completed) VALUES(1,1,'2026-11-03',1),(2,3,'2026-11-03',1); INSERT INTO life_daily_notes(owner_id,date,content) VALUES(1,'2026-11-03','私密便签正文不得收集')");
 const db={prepare(sql:string){let args:unknown[]=[];return {bind(...values:unknown[]){args=values;return this;},async all(){return {success:true,results:sqlite.prepare(sql).all(...args)};}};},async batch(statements:any[]){sqlite.exec('BEGIN');try{const rows=[];for(const s of statements)rows.push(await s.all());sqlite.exec('COMMIT');return rows;}catch(e){sqlite.exec('ROLLBACK');throw e;}}} as any;
 const todo=(name:string,at:string|null,owner=1,type='task')=>sqlite.prepare('INSERT INTO life_todos(owner_id,content,type,completed,completed_at) VALUES(?,?,?,1,?)').run(owner,name,type,at?Date.parse(at)/1000:null);
 return {sqlite,db,todo};
}
it('collects today/tomorrow, actual yesterday completion, named habits and cross-midnight focus without journals or other owners',async()=>{
 const f=fixture();try{
  for(let i=0;i<4;i++)f.sqlite.prepare("INSERT INTO daily_basics(owner_id,date,content,sort_order) VALUES(1,'2026-11-04',?,?)").run('今日事项 '+i,i);
  f.sqlite.exec("INSERT INTO daily_basics(owner_id,date,content) VALUES(1,'2026-11-05','明日预告'); INSERT INTO life_todos(owner_id,content,type,completed) VALUES(1,'当前待办','task',0)");
  f.todo('昨日完成','2026-11-03T10:00:00+08:00');f.todo('今天完成不入昨日','2026-11-04T00:00:00+08:00');f.todo('旧时间未知',null);f.todo('其他账号完成','2026-11-03T10:00:00+08:00',2);
  f.sqlite.prepare("INSERT INTO pomodoro_sessions(owner_id,task_name,started_at,ended_at,focus_minutes,completed) VALUES(1,'跨午夜任务',?,?,25,1)").run(Date.parse('2026-11-02T23:50:00+08:00')/1000,Date.parse('2026-11-03T00:15:00+08:00')/1000);
  const facts=await readBriefFacts(f.db,context());
  expect(facts.today).toMatchObject({date:'2026-11-04',priorities:{total:4,items:expect.any(Array)},pending:{total:1,items:[{name:'当前待办',deadlineAt:null}]}});expect(facts.today.priorities.items).toHaveLength(3);
  expect(facts.tomorrow.priorities.items[0].name).toBe('明日预告');expect(facts.review.tasks).toMatchObject({total:1,items:[{name:'昨日完成'}]});expect(facts.review.habits.items).toEqual([{name:'练琴',date:'2026-11-03'}]);expect(facts.review.unrecordedHabits?.items).toEqual(['未记录的习惯']);
  expect(facts.review.focus).toMatchObject({total:1,items:[{name:'跨午夜任务',startedAt:'2026-11-02T15:50:00.000Z',minutes:25}]});expect(facts.review.focusMinutes).toBe(25);
  const json=JSON.stringify(facts);expect(json).not.toContain('另一账号');expect(json).not.toContain('其他账号');expect(json).not.toContain('私密便签');expect(json).not.toContain('今天完成不入昨日');expect(facts.yesterday).toBeNull();
  const before=f.sqlite.prepare('SELECT total_changes() n').get().n;await readBriefFacts(f.db,context());expect(f.sqlite.prepare('SELECT total_changes() n').get().n).toBe(before);
 }finally{f.sqlite.close();}
});
it('keeps last week and a non-overlapping yesterday separate on a moved weekly day',async()=>{
 const f=fixture();try{
  f.todo('上周事项','2026-11-01T10:00:00+08:00');f.todo('昨日事项','2026-11-03T10:00:00+08:00');
  const facts=await readBriefFacts(f.db,context('weekly'));expect(facts.review.tasks.items.map(r=>r.name)).toEqual(['上周事项']);expect(facts.yesterday?.tasks.items.map(r=>r.name)).toEqual(['昨日事项']);expect(facts.review.unrecordedHabits).toBeNull();
 }finally{f.sqlite.close();}
});
it('bounds detail lists but preserves real totals and never substitutes missing or invalid data with zeros',async()=>{
 const f=fixture();try{
  for(let i=0;i<45;i++)f.todo('事项 '+i,'2026-11-03T10:00:00+08:00');
  const facts=await readBriefFacts(f.db,context());expect(facts.review.tasks.total).toBe(45);expect(facts.review.tasks.items).toHaveLength(20);
  expect(()=>briefFactsValue({...facts,diary:'hidden'},context())).toThrow();expect(()=>briefFactsValue({...facts,today:{...facts.today,extra:'hidden'}},context())).toThrow();expect(()=>briefFactsValue({...facts,review:{...facts.review,tasks:{total:45,items:[]}}},context())).toThrow();
  await expect(readBriefFacts({prepare(){return{bind(){return this;}};},batch:async()=>[{success:false,results:[]}]} as any,context())).rejects.toThrow('unavailable');
 }finally{f.sqlite.close();}
});
it('refuses to attach another day current plans to a recovered old occurrence and checks period binding',()=>{
 const c=context();expect(()=>briefFactQueries({...c,capturedAt:new Date(c.capturedAt.getTime()+86400000)})).toThrow();expect(()=>briefFactQueries({...c,period:{...c.period,fromDate:'2026-11-01'}})).toThrow();expect(()=>briefFactQueries({...c,owner:0})).toThrow();
});
