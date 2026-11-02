import {reportCheckinsValue,reportCheckinArchiveValue,type ReportCheckins,type ReportCheckinArchive} from './report-checkin-format';
import {reportSnapshot,type LifeReportPreview} from './life-report';
export const CHECKIN_AI_MODULES=['habits','checkins','diet','routine'] as const;
export type CheckinAIModule=typeof CHECKIN_AI_MODULES[number];
type Item={ref:string;day:number;name:string;result:'done'|'missed'|'unrecorded'|'na';note:string};
type Meal={ref:string;day:number;kind:'plan'|'eaten';description:string;portion:string};
type Routine={ref:string;day:number;bedMinute:number|null;wakeMinute:number|null;bedDayOffset:number|null;wakeDayOffset:number|null;targetBedMinute:number|null;targetWakeMinute:number|null};
export type CheckinAIInput={scopeVersion:2;periodDays:1|7;habits:Item[];checkins:Item[];diet:Meal[];routine:Routine[]};
/** Rebuild every outbound property. No owner/source/item IDs, precise calendar
 * dates, diaries, non-module text or items approved only for email. Day=1 is the
 * last complete day. Local clock minutes plus relative offsets avoid identity. */
export function checkinAIInput(report:LifeReportPreview,value:ReportCheckins|ReportCheckinArchive):CheckinAIInput{
 const r=reportSnapshot(report.ownerId,report),s='sources' in value?reportCheckinsValue(value,r):reportCheckinArchiveValue(value,r),out:CheckinAIInput={scopeVersion:2,periodDays:r.period.kind==='daily'?1:7,habits:[],checkins:[],diet:[],routine:[]};
 const end=Date.parse(s.toDateExclusive+'T00:00:00Z'),minute=(v:string|null)=>v===null?null:Number(v.slice(11,13))*60+Number(v.slice(14,16));
 for(const e of [...s.entries].sort((a,b)=>a.date.localeCompare(b.date))){const day=(end-Date.parse(e.date+'T00:00:00Z'))/86400000;
  for(const i of e.record.items.filter(i=>i.ai)){const module=i.kind==='habit'?'habits':'checkins',ref=(module==='habits'?'H':'C')+(out[module].length+1);out[module].push({ref,day,name:i.name,result:i.result,note:i.note});}
  for(const m of e.record.meals.filter(m=>m.ai))out.diet.push({ref:'D'+(out.diet.length+1),day,kind:m.kind,description:m.description,portion:m.portion});
  const sleep=e.record.sleep;if(sleep.ai&&(sleep.bedAt||sleep.wakeAt)){const offset=(v:string|null)=>v===null?null:(Date.parse(v.slice(0,10)+'T00:00:00Z')-Date.parse(e.date+'T00:00:00Z'))/86400000;out.routine.push({ref:'R'+(out.routine.length+1),day,bedMinute:minute(sleep.bedAt),wakeMinute:minute(sleep.wakeAt),bedDayOffset:offset(sleep.bedAt),wakeDayOffset:offset(sleep.wakeAt),targetBedMinute:e.record.targets.bedMinute,targetWakeMinute:e.record.targets.wakeMinute});}
 }return out;
}
export type CheckinAIAnalysis={version:1;summary:string;modules:Record<CheckinAIModule,{status:'observed'|'insufficient';observations:Array<{text:string;evidence:string[]}>;actions:string[]}>};
const fail=():never=>{throw Error('Invalid check-in analysis');};
const obj=(v:unknown,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))return fail();return v as Record<string,unknown>;};
const plain=(v:unknown,max:number)=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[<>\u0000-\u001f\u007f]|https?:\/\//i.test(v))return fail();return v.trim();};
/** Model text remains untrusted plain text. Every observation must point to
 * actual approved evidence from its own module. Empty modules cannot invent
 * observations/actions; this validates structure, not medical correctness. */
export function checkinAIAnalysis(value:unknown,input:CheckinAIInput):CheckinAIAnalysis{
 const v=obj(value,['version','summary','modules']);if(v.version!==1)return fail();const modules=obj(v.modules,[...CHECKIN_AI_MODULES]),result={} as CheckinAIAnalysis['modules'];
 for(const module of CHECKIN_AI_MODULES){const m=obj(modules[module],['status','observations','actions']),refs=new Set(input[module].map(i=>i.ref));
  if(!['observed','insufficient'].includes(String(m.status))||!Array.isArray(m.observations)||m.observations.length>2||!Array.isArray(m.actions)||m.actions.length>2||refs.size===0&&(m.status!=='insufficient'||m.observations.length||m.actions.length)||m.status==='observed'&&!m.observations.length)return fail();
  result[module]={status:m.status as 'observed'|'insufficient',observations:m.observations.map(o=>{const p=obj(o,['text','evidence']);if(!Array.isArray(p.evidence)||p.evidence.length<1||p.evidence.length>4||new Set(p.evidence).size!==p.evidence.length||p.evidence.some(ref=>typeof ref!=='string'||!refs.has(ref)))return fail();return {text:plain(p.text,180),evidence:p.evidence as string[]};}),actions:m.actions.map(a=>plain(a,120))};
 }return {version:1,summary:plain(v.summary,240),modules:result};
}
