import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {createDailyPlan,updateDailyPlan,reorderDailyPlan,validPlanDay} from './daily-plans';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
function fixture(){
 const sqlite=new DatabaseSync(':memory:'),folder=new URL('../../sql/',import.meta.url);
 for(const file of readdirSync(folder).filter(s=>s.endsWith('.sql')).sort()){sqlite.exec(readFileSync(new URL(file,folder),'utf8'));if(file==='0002.sql')sqlite.exec('ALTER TABLE feeds ADD COLUMN top INTEGER DEFAULT 0');}
 sqlite.exec("PRAGMA foreign_keys=ON; INSERT INTO users(id,username,openid,permission) VALUES(1,'a','a',1),(2,'b','b',1); INSERT INTO life_todos(id,owner_id,content) VALUES(1,1,'synthetic task'),(2,2,'other owner')");
 const db={prepare(sql:string){let args:unknown[]=[];return {bind(...values:unknown[]){args=values;return this;},async all(){return {success:true,results:sqlite.prepare(sql).all(...args)};}};}} as any;
 return {sqlite,db};
}
const create=(db:any,content:string,date='2026-11-04',owner=1)=>createDailyPlan(db,owner,{date,content,sortOrder:0,clientKey:date+':'+content});
it('validates real calendar dates and does not reject valid old offline plan dates',async()=>{
 expect(validPlanDay('2026-02-29')).toBe(false);expect(validPlanDay('2024-02-29')).toBe(true);expect(validPlanDay('2026-13-01')).toBe(false);expect(validPlanDay('2026-11-04')).toBe(true);
 const f=fixture();try{expect(await create(f.db,'older queued plan','2026-10-01')).toHaveProperty('insertedId');await expect(create(f.db,'bad','2026-02-30')).rejects.toThrow('日期');}finally{f.sqlite.close();}
});
it('admits at most three across five concurrent different creates, including per-day and owner isolation',async()=>{
 const f=fixture();try{
  const rows=await Promise.all(Array.from({length:5},(_,i)=>create(f.db,'plan '+i)));expect(rows.filter(r=>'insertedId'in r)).toHaveLength(3);expect(rows.filter(r=>'conflict'in r)).toHaveLength(2);
  expect(await create(f.db,'tomorrow','2026-11-05')).toHaveProperty('insertedId');expect(await create(f.db,'other','2026-11-04',2)).toHaveProperty('insertedId');
  expect(f.sqlite.prepare("SELECT count(*) n FROM daily_basics WHERE owner_id=1 AND date='2026-11-04'").get().n).toBe(3);
 }finally{f.sqlite.close();}
});
it('returns the same ID on concurrent retries, even after the plan was edited/moved, and never cross-links another owner',async()=>{
 const f=fixture();try{
  const rows=await Promise.all(Array.from({length:5},()=>create(f.db,'same')));expect(new Set(rows.map(r=>'insertedId'in r?r.insertedId:0)).size).toBe(1);
  const id=(rows[0] as {insertedId:number}).insertedId;
  await updateDailyPlan(f.db,1,id,{date:'2026-11-05',content:'edited'});expect(await create(f.db,'same')).toMatchObject({insertedId:id});
  expect(await createDailyPlan(f.db,1,{date:'2026-11-04',content:'cannot link',sortOrder:0,todoId:2})).toHaveProperty('conflict');
  const linked=await createDailyPlan(f.db,1,{date:'2026-11-04',content:'linked',sortOrder:0,todoId:1}) as {insertedId:number};
  f.sqlite.exec('DELETE FROM life_todos WHERE id=1');expect(f.sqlite.prepare('SELECT todo_id,content FROM daily_basics WHERE id=?').get(linked.insertedId)).toMatchObject({todo_id:null,content:'linked'});
  expect(await updateDailyPlan(f.db,2,id,{content:'forbidden'})).toMatchObject({saved:false,missing:true});
 }finally{f.sqlite.close();}
});
it('keeps full target and duplicate moves atomic; revision conflicts never modify either date',async()=>{
 const f=fixture();try{
  const original=await create(f.db,'source') as {insertedId:number};for(let i=0;i<3;i++)await create(f.db,'target '+i,'2026-11-05');
  expect(await updateDailyPlan(f.db,1,original.insertedId,{date:'2026-11-05',baseRevision:0})).toMatchObject({saved:false});
  expect(f.sqlite.prepare('SELECT date,revision FROM daily_basics WHERE id=?').get(original.insertedId)).toMatchObject({date:'2026-11-04',revision:0});
  const edits=await Promise.all(['first','second'].map(content=>updateDailyPlan(f.db,1,original.insertedId,{content,baseRevision:0})));expect(edits.filter(r=>r.saved)).toHaveLength(1);
  const two=await create(f.db,'duplicate','2026-11-06') as {insertedId:number};expect(await updateDailyPlan(f.db,1,original.insertedId,{date:'2026-11-06',content:'duplicate'})).toMatchObject({saved:false});
  expect(f.sqlite.prepare('SELECT content FROM daily_basics WHERE id=?').get(two.insertedId).content).toBe('duplicate');
 }finally{f.sqlite.close();}
});
it('stores actual completion separately from the assigned date, preserves it on moves and distinguishes legacy unknowns',async()=>{
 const f=fixture();try{
  const one=await create(f.db,'planned yesterday','2026-11-03') as {insertedId:number},completed=new Date('2026-11-04T02:00:00Z');
  await updateDailyPlan(f.db,1,one.insertedId,{completed:true},completed);await updateDailyPlan(f.db,1,one.insertedId,{date:'2026-11-05',completed:true},new Date(completed.getTime()+60000));
  expect(f.sqlite.prepare('SELECT date,completed_at FROM daily_basics WHERE id=?').get(one.insertedId)).toMatchObject({date:'2026-11-05',completed_at:completed.getTime()/1000});
  await updateDailyPlan(f.db,1,one.insertedId,{completed:false});expect(f.sqlite.prepare('SELECT completed_at FROM daily_basics WHERE id=?').get(one.insertedId).completed_at).toBeNull();
  f.sqlite.exec("INSERT INTO daily_basics(owner_id,date,content,completed) VALUES(1,'2026-11-01','legacy',1)");expect(f.sqlite.prepare("SELECT completed_at FROM daily_basics WHERE content='legacy'").get().completed_at).toBeNull();
 }finally{f.sqlite.close();}
});
it('reorders tied legacy positions atomically, with no cross-owner mutation or boundary corruption',async()=>{
 const f=fixture();try{
  const ids=[];for(let i=0;i<3;i++)ids.push((await create(f.db,'tied '+i) as {insertedId:number}).insertedId);
  const order=()=>f.sqlite.prepare("SELECT id FROM daily_basics WHERE owner_id=1 AND date='2026-11-04' ORDER BY sort_order,id").all().map((r:any)=>r.id);
  expect(await reorderDailyPlan(f.db,1,ids[1],-1)).toMatchObject({saved:true});expect(order()).toEqual([ids[1],ids[0],ids[2]]);
  expect(await reorderDailyPlan(f.db,1,ids[1],-1)).toMatchObject({saved:false});expect(await reorderDailyPlan(f.db,2,ids[1],1)).toMatchObject({saved:false});
  expect(await reorderDailyPlan(f.db,1,ids[1],1)).toMatchObject({saved:true});expect(order()).toEqual(ids);
 }finally{f.sqlite.close();}
});
