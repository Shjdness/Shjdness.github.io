import {useEffect,useRef,useState} from 'react';
import {getCookie} from 'typescript-cookie';
import {accountIdFromToken,enqueueMutation,getCached,getSyncQueue,setCached} from '../../data/local-first';
import {CLOUD_REFRESH_EVENT,lifeApi,shanghaiDay,type DailyBasic,type LifeTodo} from './model';
import {assertCurrentAccount,createForAccount,mergePendingBasics,normalizeBasics,rememberLocalId,resolveBasicId} from './sync';
import {patchCalendarCache} from './habits';

export function DailyBasicsPlanner({initialDate}:{initialDate?:string}){
 const owner=accountIdFromToken(getCookie('token'));
 return owner?<PlannerOwner key={`${owner}:${initialDate??''}`} owner={owner} initialDate={initialDate}/>:null;
}
function PlannerOwner({owner,initialDate}:{owner:number;initialDate?:string}){
 const [selected,setSelected]=useState(initialDate),[today,setToday]=useState(shanghaiDay),[drafts,setDrafts]=useState<Record<string,string>>({});
 useEffect(()=>{const timer=window.setInterval(()=>setToday(shanghaiDay()),60000);return()=>window.clearInterval(timer);},[]);
 const days=[0,1,2].map(n=>new Date(Date.parse(today+'T00:00:00Z')+n*86400000).toISOString().slice(0,10)),date=selected??today;
 // Per-date composer buffers survive tab changes; existing local/queued records
 // remain in their original account/date cache, never moved by merely browsing.
 return <section className="today-basics daily-planner"><header><h2>每日三件事</h2></header>
  <nav aria-label="安排日期">{days.map((day,i)=><button key={day} aria-pressed={day===date} onClick={()=>setSelected(i===0?undefined:day)}>{['今天','明天','后天'][i]}</button>)}</nav>
  <p className="daily-plan-date">{new Date(date+'T12:00:00Z').toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric',weekday:'long'})}（北京时间）</p>
  <PlanDay key={date} owner={owner} date={date} days={days} draft={drafts[date]??''} setDraft={value=>setDrafts(current=>({...current,[date]:value}))}/>
 </section>;
}
function PlanDay({owner,date,days,draft,setDraft}:{owner:number;date:string;days:string[];draft:string;setDraft:(s:string)=>void}){
 const [items,setItems]=useState<DailyBasic[]>([]),[todos,setTodos]=useState<LifeTodo[]>([]),[selectedTodo,setSelectedTodo]=useState<number|null>(null),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const current=useRef(items),working=useRef(false),epoch=useRef(0),alive=useRef(true);
 const apply=(next:DailyBasic[])=>{current.current=normalizeBasics(next);if(alive.current)setItems(current.current);};
 const persist=async(next:DailyBasic[])=>{
  assertCurrentAccount(owner);const normalized=normalizeBasics(next);await setCached(`life:basics:${date}`,normalized);assertCurrentAccount(owner);
  await patchCalendarCache(date,value=>({...value,basics:[...value.basics.filter(i=>i.date!==date),...normalized]}),owner);assertCurrentAccount(owner);apply(normalized);
 };
 const load=async()=>{
  const version=epoch.current;
  try{
   const cached=await getCached<DailyBasic[]>(`life:basics:${date}`);assertCurrentAccount(owner);
   if(!alive.current||version!==epoch.current||working.current)return;if(cached)apply(cached.value);
   const cloud=await lifeApi<DailyBasic[]>(`/life/basics?from=${date}&to=${date}`);assertCurrentAccount(owner);
   const merged=await mergePendingBasics(date,cloud,cached?.value??[]);assertCurrentAccount(owner);
   if(alive.current&&version===epoch.current&&!working.current)await persist(merged);
  }catch{if(alive.current&&version===epoch.current)setNotice('暂未取得云端记录；已有本机内容保留。');}
 };
 useEffect(()=>{
  alive.current=true;void load();const handler=()=>void load();window.addEventListener(CLOUD_REFRESH_EVENT,handler);
  void lifeApi<LifeTodo[]>('/life/todos').then(rows=>{assertCurrentAccount(owner);if(alive.current)setTodos(rows.filter(r=>r.type==='task'&&!r.completed&&r.id>0));}).catch(()=>undefined);
  return()=>{alive.current=false;epoch.current++;window.removeEventListener(CLOUD_REFRESH_EVENT,handler);};
 },[]);
 const perform=async(action:()=>Promise<void>)=>{
  if(working.current)return;working.current=true;epoch.current++;setBusy(true);setNotice('');
  try{assertCurrentAccount(owner);await action();}
  catch(error){if(alive.current)setNotice(error instanceof Error?error.message:'保存未确认，请保留当前内容');}
  finally{working.current=false;if(alive.current){setBusy(false);window.dispatchEvent(new Event(CLOUD_REFRESH_EVENT));}}
 };
 const create=()=>perform(async()=>{
  const content=draft.trim();if(!content||current.current.length>=3)return;
  if(current.current.some(i=>i.content.trim().toLowerCase()===content.toLowerCase()))throw Error('这个日期已有相同事项');
  const localId=-Date.now(),clientKey=crypto.randomUUID(),todoId=selectedTodo;
  const next=[...current.current,{id:localId,date,content,completed:0,sortOrder:current.current.length,clientKey,todoId,revision:0}];
  const payload={localId,date,content,sortOrder:current.current.length,clientKey,todoId};
  const synced=await createForAccount({ownerId:owner,entity:'basic',payload,persist:()=>persist(next),
   send:()=>lifeApi<{insertedId:number}>('/life/basics',{method:'POST',body:JSON.stringify(payload)}),
   apply:async data=>{if(!data.insertedId)throw Error('保存未确认');await rememberLocalId('life:basic-id-map',localId,data.insertedId,owner);await persist(next.map(i=>i.id===localId?{...i,id:data.insertedId}:i));}});
  assertCurrentAccount(owner);setDraft('');if(alive.current){setSelectedTodo(null);setNotice(synced?'已保存':'已保存在本机，等待同步；跨设备冲突可在同步状态中核对。');}
 });
 const update=(item:DailyBasic,patch:{content?:string;completed?:boolean;sortOrder?:number})=>perform(async()=>{
  const next=current.current.map(i=>i.id===item.id?{...i,...patch,completed:patch.completed===undefined?i.completed:patch.completed?1:0}:i);
  await persist(next);const payload={id:item.id,...patch};
  try{const id=await resolveBasicId(item.id);const saved=await lifeApi<{revision?:number}>(`/life/basics/${id}`,{method:'POST',body:JSON.stringify(patch)});assertCurrentAccount(owner);if(saved?.revision!==undefined)await persist(current.current.map(i=>i.id===item.id?{...i,revision:saved.revision}:i));}
  catch{await enqueueMutation('basic','update',payload,owner);if(alive.current)setNotice('修改已保存在本机，等待同步。');}
 });
 const remove=(item:DailyBasic)=>{
  if(!window.confirm(`删除 ${date} 的「${item.content}」？`))return;
  void perform(async()=>{await persist(current.current.filter(i=>i.id!==item.id));try{const id=await resolveBasicId(item.id);await lifeApi(`/life/basics/${id}`,{method:'DELETE'});assertCurrentAccount(owner);}catch{await enqueueMutation('basic','delete',{id:item.id},owner);}});
 };
 const move=(item:DailyBasic,target:string)=>perform(async()=>{
  const queued=await getSyncQueue();assertCurrentAccount(owner);
  if(item.id<1||queued.some(q=>q.entity==='basic'))throw Error('请先同步每日事项，再移动日期；原事项仍保留。');
  // Moving never optimistically deletes the source and is not blindly queued:
  // after a timeout the server may have moved it; refresh to reconcile first.
  try{await lifeApi(`/life/basics/${item.id}`,{method:'POST',body:JSON.stringify({date:target,baseRevision:item.revision??0})});}
  catch{throw Error('移动未确认或目标日期已满。原事项未在本机删除，请联网刷新核对；不会自动重试。');}
  assertCurrentAccount(owner);await persist(current.current.filter(i=>i.id!==item.id));
  const cached=await getCached<DailyBasic[]>(`life:basics:${target}`);assertCurrentAccount(owner);
  if(cached)await setCached(`life:basics:${target}`,normalizeBasics([...cached.value.filter(i=>i.id!==item.id),{...item,date:target,revision:(item.revision??0)+1}]));
  await patchCalendarCache(target,value=>({...value,basics:[...value.basics.filter(i=>i.id!==item.id),{...item,date:target}]}),owner);
  if(alive.current)setNotice('已移动，其他日期的安排未改变。');
 });
 const reorder=(item:DailyBasic,direction:-1|1)=>perform(async()=>{
  const queued=await getSyncQueue();assertCurrentAccount(owner);
  if(item.id<1||queued.some(q=>q.entity==='basic'))throw Error('请先同步每日事项，再调整顺序；原顺序仍保留。');
  await lifeApi(`/life/basics/${item.id}/reorder`,{method:'POST',body:JSON.stringify({direction})});assertCurrentAccount(owner);
  const cloud=await lifeApi<DailyBasic[]>(`/life/basics?from=${date}&to=${date}`);assertCurrentAccount(owner);await persist(cloud);
 });
 return <div className="daily-plan-day" aria-busy={busy}>
  <p>{items.filter(i=>i.completed).length} / {items.length} 已完成 · 每日最多三件，不自动顺延</p>
  {notice&&<p role="status">{notice} <button disabled={busy} onClick={()=>void load()}>刷新</button></p>}
  {items.map((item,index)=><article key={item.id}><div className="daily-plan-main"><button disabled={busy} aria-label={item.completed?'取消完成':'标记完成'} onClick={()=>void update(item,{completed:!item.completed})}>{item.completed?'✓':'○'}</button><span>{item.content}</span><button disabled={busy} aria-label="删除事项" onClick={()=>remove(item)}>×</button></div>
   <div className="daily-plan-actions"><button disabled={busy} onClick={()=>{const content=window.prompt('修改事项内容',item.content);if(content?.trim()&&content.trim()!==item.content)void update(item,{content:content.trim().slice(0,240)});}}>编辑</button><button disabled={busy||index===0} onClick={()=>void reorder(item,-1)}>前移</button><button disabled={busy||index===items.length-1} onClick={()=>void reorder(item,1)}>后移</button><select aria-label="移动到日期" value="" disabled={busy||item.id<1} onChange={e=>{if(e.target.value)void move(item,e.target.value);}}><option value="">移动到…</option>{days.filter(d=>d!==date).map(d=><option key={d} value={d}>{d}</option>)}</select></div>
  </article>)}
  <select aria-label="从待办选择" disabled={busy||items.length>=3} value={selectedTodo??''} onChange={e=>{const id=Number(e.target.value)||null;setSelectedTodo(id);const todo=todos.find(t=>t.id===id);if(todo)setDraft(todo.content);}}><option value="">从现有待办选择（可选）</option>{todos.map(t=><option key={t.id} value={t.id}>{t.content}</option>)}</select>
  <form onSubmit={e=>{e.preventDefault();void create();}}><input aria-label="新增每日事项" value={draft} maxLength={240} disabled={busy||items.length>=3} placeholder={items.length>=3?'这个日期的三件事已经安排好':'为这个日期安排一件事'} onChange={e=>{setDraft(e.target.value);setSelectedTodo(null);}}/><button disabled={busy||!draft.trim()||items.length>=3}>添加</button></form>
 </div>;
}
