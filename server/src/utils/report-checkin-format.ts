import {checkinDate,checkinValue,emptyCheckin,type Checkin} from './checkin-format';
import {reportSnapshot,type LifeReportPreview} from './life-report';
export type CheckinSourceProof={date:string;revision:number;hmac:string};
export type ReportCheckins={version:1;scopeVersion:2;generatedAt:string;fromDate:string;toDateExclusive:string;rangeFrom:string;sources:CheckinSourceProof[];entries:Array<{date:string;revision:number;updatedAt:number;record:Checkin}>;current:{asOf:string;pendingTasks:number;todos:Array<{id:number;name:string;deadlineAt:number|null}>};reading:{markedRead:number;starred:number}};
export type ReportCheckinArchive=Omit<ReportCheckins,'sources'>&{archiveOnly:true};
const fail=():never=>{throw Error('Invalid report check-in snapshot');};
const object=(v:unknown,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))return fail();return v as Record<string,unknown>;};
const count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0?Number(v):fail();
/** Do not duplicate unselected private text in derived report storage. */
export function selectedCheckin(record:Checkin,date:string):Checkin{
 const v=checkinValue(record,date);if(v.state!=='confirmed')return fail();const sleep=v.sleep.email||v.sleep.ai;
 return {version:1,state:'confirmed',items:v.items.filter(i=>i.email||i.ai),meals:v.meals.filter(m=>m.email||m.ai),sleep:sleep?v.sleep:emptyCheckin().sleep,targets:sleep?v.targets:emptyCheckin().targets};
}
export const reportRangeFrom=(report:Pick<LifeReportPreview,'period'>)=>new Date(Date.parse(report.period.end)+8*3600000-7*86400000).toISOString().slice(0,10);
function facts(value:unknown,input:LifeReportPreview,live:boolean):ReportCheckins|ReportCheckinArchive{
 const report=reportSnapshot(input.ownerId,input),keys=['version','scopeVersion','generatedAt','fromDate','toDateExclusive','rangeFrom','entries','current','reading',live?'sources':'archiveOnly'];const v=object(value,keys);
 if(v.version!==1||v.scopeVersion!==2||v.generatedAt!==report.generatedAt||v.fromDate!==report.period.fromDate||v.toDateExclusive!==report.period.toDateExclusive||v.rangeFrom!==reportRangeFrom(report)||!live&&v.archiveOnly!==true)return fail();
 const sources:CheckinSourceProof[]=[],dates=new Set<string>();
 if(live){if(!Array.isArray(v.sources)||v.sources.length>7)return fail();for(const entry of v.sources){const s=object(entry,['date','revision','hmac']),date=checkinDate(s.date);if(date<String(v.rangeFrom)||date>=report.period.toDateExclusive||dates.has(date)||count(s.revision)<1||typeof s.hmac!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(s.hmac))return fail();dates.add(date);sources.push({date,revision:Number(s.revision),hmac:s.hmac});}}
 if(!Array.isArray(v.entries)||v.entries.length>7)return fail();const seen=new Set<string>();
 const entries=v.entries.map(entry=>{const e=object(entry,['date','revision','updatedAt','record']),date=checkinDate(e.date),revision=count(e.revision),updatedAt=count(e.updatedAt);if(date<String(v.rangeFrom)||date>=report.period.toDateExclusive||seen.has(date)||revision<1||updatedAt*1000>Date.parse(report.generatedAt)||live&&!sources.some(s=>s.date===date&&s.revision===revision))return fail();seen.add(date);const record=checkinValue(e.record,date);if(JSON.stringify(record)!==JSON.stringify(selectedCheckin(record,date)))return fail();return {date,revision,updatedAt,record};});
 const c=object(v.current,['asOf','pendingTasks','todos']);if(c.asOf!==report.generatedAt||!Array.isArray(c.todos)||c.todos.length>3)return fail();
 const allowed=new Map<number,string>();for(const e of entries)for(const i of e.record.items)if(i.email&&i.source?.kind==='todo')allowed.set(i.source.id,i.name);
 const todoIds=new Set<number>();const todos=c.todos.map(entry=>{const t=object(entry,['id','name','deadlineAt']),id=count(t.id);if(id<1||allowed.get(id)!==t.name||todoIds.has(id))return fail();todoIds.add(id);return {id,name:String(t.name),deadlineAt:t.deadlineAt===null?null:count(t.deadlineAt)};});
 const r=object(v.reading,['markedRead','starred']);const common={version:1 as const,scopeVersion:2 as const,generatedAt:report.generatedAt,fromDate:report.period.fromDate,toDateExclusive:report.period.toDateExclusive,rangeFrom:reportRangeFrom(report),entries,current:{asOf:report.generatedAt,pendingTasks:count(c.pendingTasks),todos},reading:{markedRead:count(r.markedRead),starred:count(r.starred)}};
 const result=live?{...common,sources}:{...common,archiveOnly:true as const};if(new TextEncoder().encode(JSON.stringify(result)).length>128000)return fail();return result;
}
export const reportCheckinsValue=(v:unknown,r:LifeReportPreview)=>facts(v,r,true) as ReportCheckins;
export const reportCheckinArchiveValue=(v:unknown,r:LifeReportPreview)=>facts(v,r,false) as ReportCheckinArchive;
/** Archives preserve readable history but remove every source admission proof. */
export function archiveReportCheckins(value:ReportCheckins,report:LifeReportPreview):ReportCheckinArchive{const {sources:_proofs,...rest}=reportCheckinsValue(value,report);return reportCheckinArchiveValue({...rest,archiveOnly:true},report);}
/** A combined model result can mention ANY approved input. Never include it in
 * mail when even one AI-only item was excluded from the email channel. */
export function checkinAIShareableInMail(snapshot:Pick<ReportCheckins,'entries'>){return snapshot.entries.every(e=>e.record.items.every(i=>!i.ai||i.email)&&e.record.meals.every(m=>!m.ai||m.email)&&(!e.record.sleep.ai||e.record.sleep.email));}
