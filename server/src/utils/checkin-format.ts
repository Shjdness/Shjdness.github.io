/** Personal structured records only. Never accept arbitrary journal/report fields. */
export type CheckinItem={key:string;kind:'habit'|'checkin';source:{kind:'habit'|'todo';id:number}|null;name:string;result:'done'|'missed'|'unrecorded'|'na';note:string;email:boolean;ai:boolean};
export type CheckinMeal={key:string;kind:'plan'|'eaten';description:string;portion:string;email:boolean;ai:boolean};
export type Checkin={version:1;state:'draft'|'confirmed';items:CheckinItem[];meals:CheckinMeal[];sleep:{bedAt:string|null;wakeAt:string|null;email:boolean;ai:boolean};targets:{bedMinute:number|null;wakeMinute:number|null}};
const fail=():never=>{throw Error('Invalid check-in record');};
const obj=(v:unknown,keys:string[]):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))return fail();return v as Record<string,unknown>;};
const text=(v:unknown,max:number,required=false)=>{if(typeof v!=='string'||v.length>max||/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)||required&&!v.trim())return fail();return v.trim();};
const flag=(v:unknown)=>typeof v==='boolean'?v:fail();
const choice=<T extends string>(v:unknown,values:readonly T[]):T=>typeof v==='string'&&values.includes(v as T)?v as T:fail();
export const checkinKey=(v:unknown)=>{const key=text(v,36,true);return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)?key:fail();};
export function checkinDate(value:unknown){const s=text(value,10,true);if(!/^20\d{2}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)return fail();return s;}
export const shanghaiDate=(now=Date.now())=>new Date(now+8*3600000).toISOString().slice(0,10);
export function checkinValue(value:unknown,date:string):Checkin{
  checkinDate(date);const v=obj(value,['version','state','items','meals','sleep','targets']);if(v.version!==1)return fail();
  const keys=new Set<string>();const unique=(key:unknown)=>{const s=checkinKey(key);if(keys.has(s))return fail();keys.add(s);return s;};
  if(!Array.isArray(v.items)||v.items.length>12||!Array.isArray(v.meals)||v.meals.length>6)return fail();
  const sources=new Set<string>();
  const items=v.items.map(value=>{const i=obj(value,['key','kind','source','name','result','note','email','ai']);let source:CheckinItem['source']=null;
    if(i.source!==null){const s=obj(i.source,['kind','id']);const kind=choice(s.kind,['habit','todo'] as const);if(!Number.isSafeInteger(s.id)||Number(s.id)<=0||sources.has(kind+':'+s.id))return fail();sources.add(kind+':'+s.id);source={kind,id:Number(s.id)};}
    return {key:unique(i.key),kind:choice(i.kind,['habit','checkin'] as const),source,name:text(i.name,100,v.state==='confirmed'),result:choice(i.result,['done','missed','unrecorded','na'] as const),note:text(i.note,140),email:flag(i.email),ai:flag(i.ai)};});
  const meals=v.meals.map(value=>{const m=obj(value,['key','kind','description','portion','email','ai']);return {key:unique(m.key),kind:choice(m.kind,['plan','eaten'] as const),description:text(m.description,240,v.state==='confirmed'),portion:text(m.portion,100),email:flag(m.email),ai:flag(m.ai)};});
  const s=obj(v.sleep,['bedAt','wakeAt','email','ai']);
  const stamp=(v:unknown)=>{if(v===null)return null;const t=text(v,25,true);if(!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(t))return fail();checkinDate(t.slice(0,10));const n=Date.parse(t),start=Date.parse(date+'T00:00:00+08:00');if(!Number.isFinite(n)||t.slice(11,16)>'23:59'||Number(t.slice(14,16))>59||n<start||n>=start+48*3600000)return fail();return t;};
  const targets=obj(v.targets,['bedMinute','wakeMinute']);const minute=(v:unknown)=>v===null?null:Number.isInteger(v)&&Number(v)>=0&&Number(v)<1440?Number(v):fail();
  const result:Checkin={version:1,state:choice(v.state,['draft','confirmed'] as const),items,meals,sleep:{bedAt:stamp(s.bedAt),wakeAt:stamp(s.wakeAt),email:flag(s.email),ai:flag(s.ai)},targets:{bedMinute:minute(targets.bedMinute),wakeMinute:minute(targets.wakeMinute)}};
  if(new TextEncoder().encode(JSON.stringify(result)).length>16000)return fail();return result;
}
export const emptyCheckin=():Checkin=>({version:1,state:'draft',items:[],meals:[],sleep:{bedAt:null,wakeAt:null,email:false,ai:false},targets:{bedMinute:null,wakeMinute:null}});
/** Distinct projections: draft/private/unselected fields cannot leak downstream.
 * Calendar date, owner, internal keys and arbitrary text fields are not emitted. */
export function projectCheckin(value:Checkin,date:string,scope:'email'|'ai'){
  const v=checkinValue(value,date);if(v.state!=='confirmed')return null;
  return {items:v.items.filter(i=>i[scope]).map(i=>({kind:i.kind,name:i.name,result:i.result,note:i.note})),meals:v.meals.filter(m=>m[scope]).map(m=>({kind:m.kind,description:m.description,portion:m.portion})),sleep:v.sleep[scope]?{bedMinute:v.sleep.bedAt?Number(v.sleep.bedAt.slice(11,13))*60+Number(v.sleep.bedAt.slice(14,16)):null,wakeMinute:v.sleep.wakeAt?Number(v.sleep.wakeAt.slice(11,13))*60+Number(v.sleep.wakeAt.slice(14,16)):null,bedDayOffset:v.sleep.bedAt?Number(v.sleep.bedAt.slice(0,10)!==date):null,wakeDayOffset:v.sleep.wakeAt?Number(v.sleep.wakeAt.slice(0,10)!==date):null,targets:v.targets}:null};
}
