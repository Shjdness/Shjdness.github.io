import type {D1Database} from '@cloudflare/workers-types';
import {reportWindow,type ReportWindow} from './life-report';

type Query={sql:string;args:Array<string|number>};
export type BriefList<T>={total:number;items:T[]};
export type BriefReview={fromDate:string;toDateExclusive:string;tasks:BriefList<{name:string;completedAt:string}>;successes:BriefList<{name:string;completedAt:string}>;habits:BriefList<{name:string;date:string}>;focus:BriefList<{name:string;startedAt:string;endedAt:string;minutes:number}>;focusMinutes:number;unrecordedHabits:BriefList<string>|null};
export type BriefFacts={version:1;capturedAt:string;scheduledFor:string;today:{date:string;priorities:BriefList<{name:string;completed:boolean}>;pending:BriefList<{name:string;deadlineAt:string|null}>};tomorrow:{date:string;priorities:BriefList<{name:string;completed:boolean}>};review:BriefReview;yesterday:BriefReview|null};
export type BriefContext={owner:number;period:ReportWindow;capturedAt:Date;scheduledFor:Date};
const day=(date:Date)=>new Date(date.getTime()+8*3600000).toISOString().slice(0,10);
const fail=():never=>{throw Error('Report brief facts unavailable');};
const num=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0?Number(v):fail();
const label=(v:unknown,fallback:string)=>{if(typeof v!=='string')return fail();const clean=v.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu,' ').replace(/\s+/g,' ').trim()||fallback;return clean.length>100?clean.slice(0,99)+'…':clean;};
const stamp=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=4102444800?new Date(Number(v)*1000).toISOString():fail();
export function briefContext(context:BriefContext){
 const {owner,period,capturedAt,scheduledFor}=context;
 if(!Number.isSafeInteger(owner)||owner<1||!Number.isFinite(capturedAt.getTime())||!Number.isFinite(scheduledFor.getTime())||capturedAt.getTime()<Date.parse(period.end))return fail();
 const expected=reportWindow(period.kind,scheduledFor);
 if((Object.keys(expected) as Array<keyof ReportWindow>).some(key=>expected[key]!==period[key])||day(capturedAt)!==day(scheduledFor))return fail();
 const today=day(scheduledFor),tomorrow=new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10),yesterday=reportWindow('daily',scheduledFor);
 return {today,tomorrow,yesterday};
}
function prioritiesQuery(owner:number,date:string):Query{return {sql:'SELECT content,completed,COUNT(*) OVER() AS total FROM daily_basics WHERE owner_id=? AND date=? ORDER BY sort_order,id LIMIT 3',args:[owner,date]};}
function reviewQueries(owner:number,period:ReportWindow):Query[]{
 const start=Date.parse(period.start)/1000,end=Date.parse(period.end)/1000;
 const done="owner_id=? AND completed=1 AND type!='daily' AND completed_at>=? AND completed_at<?";
 const focus='owner_id=? AND completed=1 AND ended_at>=? AND ended_at<?';
 const habit='l.owner_id=? AND l.completed=1 AND l.date>=? AND l.date<?';
 const result:Query[]=[
  {sql:`SELECT content,completed_at,COUNT(*) OVER() AS total FROM life_todos WHERE ${done} AND type='task' ORDER BY completed_at DESC,id LIMIT 20`,args:[owner,start,end]},
  {sql:`SELECT content,completed_at,COUNT(*) OVER() AS total FROM life_todos WHERE ${done} AND type IN ('success','learn') ORDER BY completed_at DESC,id LIMIT 20`,args:[owner,start,end]},
  {sql:`SELECT h.name,l.date,COUNT(*) OVER() AS total FROM habit_logs l JOIN habits h ON h.id=l.habit_id AND h.owner_id=l.owner_id WHERE ${habit} ORDER BY l.date DESC,h.id LIMIT 30`,args:[owner,period.fromDate,period.toDateExclusive]},
  {sql:`SELECT task_name,started_at,ended_at,focus_minutes,COUNT(*) OVER() AS total FROM pomodoro_sessions WHERE ${focus} ORDER BY ended_at DESC,id LIMIT 20`,args:[owner,start,end]},
  {sql:`SELECT COALESCE(SUM(CASE WHEN focus_minutes>=0 THEN focus_minutes ELSE 0 END),0) AS minutes FROM pomodoro_sessions WHERE ${focus}`,args:[owner,start,end]},
  {sql:`SELECT h.name,COUNT(*) OVER() AS total FROM habits h WHERE h.owner_id=? AND h.active=1 AND NOT EXISTS(SELECT 1 FROM habit_logs l WHERE l.owner_id=h.owner_id AND l.habit_id=h.id AND l.date=? AND l.completed=1) ORDER BY h.id LIMIT 20`,args:[owner,period.fromDate]},
 ];
 return result;
}
/** All source selections use one batch/read transaction. No journal/memo/body
 * column is selected. Returned names are PRIVATE EMAIL facts, never AI input.
 * Callers must encrypt before persistence, and bind a new immutable report. */
export function briefFactQueries(context:BriefContext):Query[]{
 const {today,tomorrow,yesterday}=briefContext(context),owner=context.owner;
 return [prioritiesQuery(owner,today),prioritiesQuery(owner,tomorrow),
  {sql:"SELECT content,deadline_at,COUNT(*) OVER() AS total FROM life_todos WHERE owner_id=? AND type='task' AND completed=0 ORDER BY deadline_at IS NULL,deadline_at,id LIMIT 20",args:[owner]},
  ...reviewQueries(owner,context.period),...(context.period.kind==='weekly'?reviewQueries(owner,yesterday):[])];
}
type Row=Record<string,unknown>;
function list<T>(rows:Row[],map:(r:Row)=>T):BriefList<T>{
 const total=rows.length?num(rows[0].total):0;if(total<rows.length||rows.some(r=>num(r.total)!==total))return fail();return {total,items:rows.map(map)};
}
function review(period:ReportWindow,rows:Row[][]):BriefReview{
 if(rows.length!==6||rows.some(r=>!Array.isArray(r)))return fail();
 const task=(r:Row)=>({name:label(r.content,'未命名事项'),completedAt:stamp(r.completed_at)});
 const inWindow=(value:string)=>Date.parse(value)>=Date.parse(period.start)&&Date.parse(value)<Date.parse(period.end);
 const tasks=list(rows[0],task),successes=list(rows[1],task);
 const habits=list(rows[2],r=>{if(typeof r.date!=='string'||r.date<period.fromDate||r.date>=period.toDateExclusive)return fail();return {name:label(r.name,'未命名习惯'),date:r.date};});
 const focus=list(rows[3],r=>({name:label(r.task_name,'未命名任务'),startedAt:stamp(r.started_at),endedAt:stamp(r.ended_at),minutes:num(r.focus_minutes)}));
 if([...tasks.items,...successes.items].some(r=>!inWindow(r.completedAt))||focus.items.some(r=>!inWindow(r.endedAt)||r.startedAt>r.endedAt))return fail();
 const focusMinutes=num(rows[4][0]?.minutes);if(focus.items.reduce((n,r)=>n+r.minutes,0)>focusMinutes)return fail();
 return {fromDate:period.fromDate,toDateExclusive:period.toDateExclusive,tasks,successes,habits,focus,focusMinutes,unrecordedHabits:period.kind==='daily'?list(rows[5],r=>label(r.name,'未命名习惯')):null};
}
export function briefFactsFromRows(context:BriefContext,rows:Row[][]):BriefFacts{
 const {today,tomorrow,yesterday}=briefContext(context);
 if(rows.length!==(context.period.kind==='weekly'?15:9)||rows.some(r=>!Array.isArray(r)))return fail();
 const priorities=(r:Row)=>{if(![0,1].includes(Number(r.completed)))return fail();return {name:label(r.content,'未命名事项'),completed:r.completed===1};};
 return briefFactsValue({version:1,capturedAt:context.capturedAt.toISOString(),scheduledFor:context.scheduledFor.toISOString(),today:{date:today,priorities:list(rows[0],priorities),pending:list(rows[2],r=>({name:label(r.content,'未命名待办'),deadlineAt:r.deadline_at===null?null:stamp(r.deadline_at)}))},tomorrow:{date:tomorrow,priorities:list(rows[1],priorities)},review:review(context.period,rows.slice(3,9)),yesterday:context.period.kind==='weekly'?review(yesterday,rows.slice(9,15)):null},context);
}
export async function readBriefFacts(db:D1Database,context:BriefContext):Promise<BriefFacts>{
 const rows=await db.batch<Row>(briefFactQueries(context).map(q=>db.prepare(q.sql).bind(...q.args)));
 if(rows.some(r=>!r.success))return fail();return briefFactsFromRows(context,rows.map(r=>r.results));
}

const object=(value:unknown,keys:string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))return fail();return value as Record<string,unknown>;};
const savedLabel=(v:unknown)=>{const text=label(v,'');return typeof v==='string'&&text===v&&text.length>0?text:fail();};
const savedStamp=(v:unknown)=>{if(typeof v!=='string'||!Number.isFinite(Date.parse(v)))return fail();const normalized=stamp(Date.parse(v)/1000);return normalized===v?normalized:fail();};
function savedList<T>(input:unknown,max:number,parse:(v:unknown)=>T):BriefList<T>{
 const v=object(input,['total','items']),total=num(v.total);if(!Array.isArray(v.items)||v.items.length!==Math.min(max,total))return fail();return {total,items:v.items.map(parse)};
}
function savedReview(input:unknown,period:ReportWindow):BriefReview{
 const v=object(input,['fromDate','toDateExclusive','tasks','successes','habits','focus','focusMinutes','unrecordedHabits']);if(v.fromDate!==period.fromDate||v.toDateExclusive!==period.toDateExclusive)return fail();
 const inTime=(s:string)=>Date.parse(s)>=Date.parse(period.start)&&Date.parse(s)<Date.parse(period.end);
 const task=(input:unknown)=>{const t=object(input,['name','completedAt']),completedAt=savedStamp(t.completedAt);if(!inTime(completedAt))return fail();return {name:savedLabel(t.name),completedAt};};
 const focus=savedList(v.focus,20,input=>{const s=object(input,['name','startedAt','endedAt','minutes']),startedAt=savedStamp(s.startedAt),endedAt=savedStamp(s.endedAt);if(!inTime(endedAt)||startedAt>endedAt)return fail();return {name:savedLabel(s.name),startedAt,endedAt,minutes:num(s.minutes)};});
 const focusMinutes=num(v.focusMinutes);if(focus.items.reduce((n,s)=>n+s.minutes,0)>focusMinutes)return fail();
 if(period.kind==='weekly'&&v.unrecordedHabits!==null)return fail();
 return {fromDate:period.fromDate,toDateExclusive:period.toDateExclusive,tasks:savedList(v.tasks,20,task),successes:savedList(v.successes,20,task),habits:savedList(v.habits,30,input=>{const h=object(input,['name','date']);if(typeof h.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(h.date)||h.date<period.fromDate||h.date>=period.toDateExclusive)return fail();return {name:savedLabel(h.name),date:h.date};}),focus,focusMinutes,unrecordedHabits:period.kind==='daily'?savedList(v.unrecordedHabits,20,savedLabel):null};
}
/** Strict projection at encrypted archive/mail boundaries. Additional fields
 * such as journal bodies, arbitrary notes or identity are always rejected. */
export function briefFactsValue(input:unknown,context:BriefContext):BriefFacts{
 const {today,tomorrow,yesterday}=briefContext(context),v=object(input,['version','capturedAt','scheduledFor','today','tomorrow','review','yesterday']);
 if(v.version!==1||v.capturedAt!==context.capturedAt.toISOString()||v.scheduledFor!==context.scheduledFor.toISOString())return fail();
 const a=object(v.today,['date','priorities','pending']),b=object(v.tomorrow,['date','priorities']);if(a.date!==today||b.date!==tomorrow)return fail();
 const priority=(input:unknown)=>{const p=object(input,['name','completed']);if(typeof p.completed!=='boolean')return fail();return {name:savedLabel(p.name),completed:p.completed};};
 if(context.period.kind==='daily'&&v.yesterday!==null)return fail();
 const result:BriefFacts={version:1,capturedAt:context.capturedAt.toISOString(),scheduledFor:context.scheduledFor.toISOString(),today:{date:today,priorities:savedList(a.priorities,3,priority),pending:savedList(a.pending,20,input=>{const p=object(input,['name','deadlineAt']);return {name:savedLabel(p.name),deadlineAt:p.deadlineAt===null?null:savedStamp(p.deadlineAt)};})},tomorrow:{date:tomorrow,priorities:savedList(b.priorities,3,priority)},review:savedReview(v.review,context.period),yesterday:context.period.kind==='weekly'?savedReview(v.yesterday,yesterday):null};
 if(new TextEncoder().encode(JSON.stringify(result)).length>100000)return fail();return result;
}
