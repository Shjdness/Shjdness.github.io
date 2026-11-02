import {useContext,useEffect,useRef,useState} from 'react';
import {Link} from 'wouter';
import {getCookie} from 'typescript-cookie';
import {ProfileContext} from '../../state/profile';
import {endpoint} from '../../main';
import {accountIdFromToken} from '../../data/local-first';
import {loadCheckinDrafts,saveCheckinDraft,type CheckinDraft,type CheckinDraftCopy} from '../../data/checkin-drafts';
import {checkinDate,checkinKey,checkinValue,emptyCheckin,projectCheckin,shanghaiDate,type Checkin,type CheckinItem,type CheckinMeal} from '../../../../server/src/utils/checkin-format';
import {LifeDenied,LifeLayout} from './layout';
import './check-in.css';

type Draft=CheckinDraft;
type Cloud={value:Checkin;revision:number;updatedAt:number}|null;
const resultNames={done:'已完成',missed:'明确未完成',unrecorded:'未记录',na:'不适用'};
export function LifeCheckinView(){
  const profile=useContext(ProfileContext),token=getCookie('token');
  const [date,setDate]=useState(shanghaiDate());
  const owner=profile?.role==='owner'&&accountIdFromToken(token)===profile.id?profile.id:null;
  if(!owner||!token)return <LifeDenied/>;
  return <LifeLayout section="check-in" title="生活复盘" intro="记下打卡、饮食与作息。可以只填一部分，日记保持独立。">
    <div className="checkin-toolbar"><label>记录日期（北京时间）<input type="date" value={date} max={shanghaiDate()} min="2000-01-01" onChange={e=>{try{const next=checkinDate(e.target.value);if(next<=shanghaiDate())setDate(next);}catch{}}}/></label><Link href="/life/reports">报告与邮件 →</Link><Link href="/life">返回 Life</Link></div>
    <CheckinEditor key={token+date} owner={owner} token={token} date={date}/>
  </LifeLayout>;
}
function CheckinEditor({owner,token,date}:{owner:number;token:string;date:string}){
  const [draft,setDraft]=useState<Draft>({value:emptyCheckin(),baseRevision:0,clientKey:crypto.randomUUID(),dirty:false});
  const draftRef=useRef(draft),active=useRef(true),generation=useRef(0),writes=useRef(Promise.resolve()),localPending=useRef(0);
  const [ready,setReady]=useState(false),[configured,setConfigured]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[cloud,setCloud]=useState<Cloud>(null),[conflict,setConflict]=useState(false);
  const [localBlocked,setLocalBlocked]=useState(false);
  const [compareRevision,setCompareRevision]=useState<number|null>(null);
  const [revisions,setRevisions]=useState<Array<{revision:number;updatedAt:number;record:Checkin}>>([]);
  const editor=useRef(crypto.randomUUID()),[copies,setCopies]=useState<CheckinDraftCopy[]>([]);
  const [history,setHistory]=useState<Array<{date:string;revision:number}>>([]),[references,setReferences]=useState<Array<{name:string;kind:'habit'|'checkin';source:CheckinItem['source']}>>([]);
  const current=()=>active.current&&getCookie('token')===token;
  async function request<T,>(path:string,body?:unknown):Promise<T>{
    if(!current())throw Error('账号已变化');const controller=new AbortController(),timer=window.setTimeout(()=>controller.abort(),15000);
    try{const r=await fetch(endpoint+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,cache:'no-store',credentials:'omit'});if(r.status===409)throw Error('CONFLICT');if(!r.ok)throw Error(r.status===503?'云端暂不可用，本机草稿保留；请稍后手动重试':r.status===429?'操作较频繁，请稍后重试':'读取或保存未完成，请重试');const value=await r.json();if(!current())throw Error('账号已变化');return value as T;}finally{clearTimeout(timer);}
  }
  const set=(value:Draft)=>{draftRef.current=value;setDraft(value);};
  function persist(value:Draft){
    // Explicit owner/date/editor captured before async storage. Each tab has a
    // separate copy; ordered writes cannot replace a later keystroke.
    localPending.current++;
    const pending=writes.current.catch(()=>{}).then(()=>saveCheckinDraft(owner,date,editor.current,value));writes.current=pending;
    void pending.then(()=>{localPending.current--;},()=>{localPending.current--;});
    void pending.then(()=>{if(current()&&draftRef.current===value)setMessage(value.dirty?'本机草稿已保存，尚未同步云端':'云端与本机记录一致');}).catch(()=>{if(current())setMessage('本机存储失败，请保留页面并复制内容后再离开');});
    return pending;
  }
  const edit=(fn:(v:Checkin)=>Checkin)=>{if(busy||!ready||localBlocked)return;const next={...draftRef.current,value:{...fn(draftRef.current.value),state:'draft' as const},dirty:true,clientKey:crypto.randomUUID()};set(next);void persist(next);};
  useEffect(()=>{const guard=(e:BeforeUnloadEvent)=>{if(localPending.current){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[]);
  useEffect(()=>{active.current=true;const gen=++generation.current;const live=()=>current()&&generation.current===gen;void (async()=>{
    try{
      const stored=await loadCheckinDrafts(owner,date);if(!live())return;setCopies(stored.filter(r=>r.draft.dirty));const cached=stored[0]?{value:stored[0].draft}:null;
      let local:Draft|null=null;
      if(cached){try{checkinValue(cached.value.value,date);checkinKey(cached.value.clientKey);if(!Number.isSafeInteger(cached.value.baseRevision)||cached.value.baseRevision<0||typeof cached.value.dirty!=='boolean')throw Error();local=cached.value;}catch{setMessage('本机草稿格式需要核对，未自动覆盖；请保留当前浏览器数据');setLocalBlocked(true);return;}}
      if(local)set(local);
      try{
        const status=await request<{ownerId:number;configured:boolean}>('/life/checkins/status');if(!live())return;if(status.ownerId!==owner)throw Error('账号不匹配');setConfigured(status.configured);
        if(status.configured){const result=await request<{ownerId:number;record:Cloud}>('/life/checkins/'+date);if(!live())return;if(result.ownerId!==owner)throw Error('账号不匹配');const record=result.record;setCloud(record);
          if(local?.dirty){if(local.baseRevision!==(record?.revision??0)){setConflict(true);setCompareRevision(record?.revision??0);}setMessage('已恢复本机未同步草稿；云端内容没有覆盖它');}
          else{const next:Draft={value:record?checkinValue(record.value,date):emptyCheckin(),baseRevision:record?.revision??0,clientKey:crypto.randomUUID(),dirty:false};set(next);await persist(next);}
        }else setMessage('新模块加密配置尚未就绪；可记录本机草稿，尚不能云端保存。现有邮件照常运行。');
        const h=await request<{ownerId:number;items:Array<{date:string;revision:number}>}>('/life/checkins');if(live()&&h.ownerId===owner)setHistory(h.items);
      }catch(e){if(live())setMessage(e instanceof Error?e.message:'云端读取失败，本机草稿保留');}
    }catch{if(live()){setLocalBlocked(true);setMessage('本机草稿读取失败，已停止编辑以保护原稿；请保留浏览器数据并重试');}}
    finally{if(live())setReady(true);}
  })();
    return()=>{active.current=false;generation.current++;};
  },[]);
  const save=async(state:'draft'|'confirmed')=>{
    if(busy||!ready||!configured||conflict||localBlocked||!current())return;setBusy(true);
    try{const value=checkinValue({...draftRef.current.value,state},date),sent={...draftRef.current,value,dirty:true};set(sent);await persist(sent);
      const r=await request<{ownerId:number;saved:boolean;revision:number}>('/life/checkins/'+date,{record:value,baseRevision:sent.baseRevision,clientKey:sent.clientKey});if(r.ownerId!==owner||!r.saved||!Number.isSafeInteger(r.revision))throw Error('保存结果未确认，请先刷新核对，不要连续提交');
      const next={...sent,baseRevision:r.revision,dirty:false};set(next);setCloud({value,revision:r.revision,updatedAt:Date.now()/1000});await persist(next);setMessage(state==='confirmed'?'已确认并保存；AI 与新版邮件将在后续模块接通后使用选定内容':'云端草稿已保存，尚不进入报告');
    }catch(e){if(current()){if(e instanceof Error&&e.message==='CONFLICT'){setConflict(true);setCloud(null);setCompareRevision(null);setMessage('另一设备已修改此日记录，本机内容已保留。请先读取云端版本比较');}else setMessage(e instanceof Error?e.message:'保存未确认，本机草稿保留');}}
    finally{if(current())setBusy(false);}
  };
  const compare=async()=>{setBusy(true);setCompareRevision(null);try{const r=await request<{ownerId:number;record:Cloud}>('/life/checkins/'+date);if(r.ownerId!==owner)throw Error('账号不匹配');setCloud(r.record);setCompareRevision(r.record?.revision??0);setConflict(true);setMessage('已读取云端版本，本机草稿未覆盖。请比较后选择');}catch{if(current())setMessage('云端版本读取失败，本机草稿保留');}finally{if(current())setBusy(false);}};
  const loadReferences=async()=>{setBusy(true);try{const [habits,todos]=await Promise.all([request<Array<{id:number;name:string}>>('/habit'),request<Array<{id:number;content:string;type:string}>>('/life/todos')]);if(!Array.isArray(habits)||!Array.isArray(todos))throw Error();setReferences([...habits.slice(0,30).map(h=>({name:h.name,kind:'habit' as const,source:{kind:'habit' as const,id:h.id}})),...todos.filter(t=>t.type==='task'||t.type==='learn').slice(0,30).map(t=>({name:t.content,kind:'checkin' as const,source:{kind:'todo' as const,id:t.id}}))]);}catch{if(current())setMessage('项目列表读取失败，可直接手动添加');}finally{if(current())setBusy(false);}};
  if(getCookie('token')!==token)return <LifeDenied/>;
  const value=draft.value;
  const addItem=(name='',kind:'habit'|'checkin'='checkin',source:CheckinItem['source']=null)=>edit(v=>({...v,items:[...v.items,{key:crypto.randomUUID(),kind,source,name:name.slice(0,100),result:'unrecorded',note:'',email:false,ai:false}]}));
  const patchItem=(key:string,patch:Partial<CheckinItem>)=>edit(v=>({...v,items:v.items.map(i=>i.key===key?{...i,...patch}:i)}));
  const patchMeal=(key:string,patch:Partial<CheckinMeal>)=>edit(v=>({...v,meals:v.meals.map(m=>m.key===key?{...m,...patch}:m)}));
  const preview=(scope:'email'|'ai')=>{try{return JSON.stringify(projectCheckin({...value,state:'confirmed'},date,scope),null,2);}catch{return '请先补全项目名称或食物描述；草稿仍会保留。';}};
  return <div className="checkin-workspace">
    <p role="status" aria-live="polite">{!ready?'正在读取…':message||'可以部分填写，所有外发选项均可逐项选择。'}</p>
    <p className="checkin-notice">本站保存与外发分开。只记录本页内容；不读取日记、便签或 RSS 正文。当前阶段不会调用 AI、发送或重发邮件。本机草稿保存在此浏览器，不能替代云端备份。</p>
    <fieldset disabled={busy||!ready||localBlocked}>
    <div className="checkin-grid">
      <section><h2>习惯与打卡</h2><p>“未记录”不等于“未完成”。每日执行仍是记忆清单，不计算打卡率。</p>
        <div className="checkin-actions"><button type="button" disabled={value.items.length>=12} onClick={()=>addItem()}>添加项目</button><button type="button" onClick={()=>void loadReferences()}>选择已有项目</button></div>
        {!!references.length&&<label>选择一个项目（保留来源，不改原项目）<select value="" disabled={value.items.length>=12} onChange={e=>{const item=references[Number(e.target.value)];if(item&&!value.items.some(i=>i.source?.id===item.source?.id&&i.source?.kind===item.source?.kind))addItem(item.name,item.kind,item.source);}}><option value="">请选择</option>{references.map((r,i)=><option value={i} key={i}>{r.name}</option>)}</select></label>}
        {value.items.map(i=><article key={i.key}><label>项目名称<input maxLength={100} value={i.name} onChange={e=>patchItem(i.key,{name:e.target.value})}/></label>{i.source&&<p>已引用已有项目 <button type="button" onClick={()=>patchItem(i.key,{source:null})}>解除关联，保留名称</button></p>}<label>类型<select value={i.kind} onChange={e=>patchItem(i.key,{kind:e.target.value as CheckinItem['kind']})}><option value="checkin">打卡项目</option><option value="habit">习惯观察</option></select></label><label>结果<select value={i.result} onChange={e=>patchItem(i.key,{result:e.target.value as CheckinItem['result']})}>{Object.entries(resultNames).map(([k,n])=><option key={k} value={k}>{n}</option>)}</select></label><label>本项目的简短备注<textarea maxLength={140} value={i.note} onChange={e=>patchItem(i.key,{note:e.target.value})}/></label><Scopes email={i.email} ai={i.ai} change={p=>patchItem(i.key,p)}/><button type="button" onClick={()=>edit(v=>({...v,items:v.items.filter(x=>x.key!==i.key)}))}>移除此日项目</button></article>)}
      </section>
      <section><h2>食谱与饮食</h2><p>区分准备做的食谱与已经吃过的食物。份量未知可以留空，不推断减重目标。</p><button type="button" disabled={value.meals.length>=6} onClick={()=>edit(v=>({...v,meals:[...v.meals,{key:crypto.randomUUID(),kind:'eaten',description:'',portion:'',email:false,ai:false}]}))}>添加饮食记录</button>
        {value.meals.map(m=><article key={m.key}><label>记录类型<select value={m.kind} onChange={e=>patchMeal(m.key,{kind:e.target.value as CheckinMeal['kind']})}><option value="eaten">已经吃过</option><option value="plan">计划食谱（不计摄入）</option></select></label><label>食物与烹饪说明<textarea maxLength={240} value={m.description} onChange={e=>patchMeal(m.key,{description:e.target.value})}/></label><label>份量（选填）<input maxLength={100} value={m.portion} onChange={e=>patchMeal(m.key,{portion:e.target.value})}/></label><Scopes email={m.email} ai={m.ai} change={p=>patchMeal(m.key,p)}/><button type="button" onClick={()=>edit(v=>({...v,meals:v.meals.filter(x=>x.key!==m.key)}))}>移除此条记录</button></article>)}
      </section>
      <section><h2>作息</h2><p>记录日及其次日的北京时间。上床至起床的间隔不等于实际睡眠时长。</p>{(['bedAt','wakeAt'] as const).map(k=><label key={k}>{k==='bedAt'?'准备睡觉 / 上床':'起床'}<input type="datetime-local" step={60} min={date+'T00:00'} max={new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10)+'T23:59'} value={value.sleep[k]?.slice(0,16)??''} onChange={e=>edit(v=>({...v,sleep:{...v.sleep,[k]:e.target.value?e.target.value+':00+08:00':null}}))}/></label>)}
        <Scopes email={value.sleep.email} ai={value.sleep.ai} change={p=>edit(v=>({...v,sleep:{...v.sleep,...p}}))}/>
        <h3>当日目标（选填）</h3><p>保存在当日记录中，修改今天不改过去的目标。</p>{(['bedMinute','wakeMinute'] as const).map(k=><label key={k}>{k==='bedMinute'?'上床目标':'起床目标'}<input type="time" value={value.targets[k]===null?'':String(Math.floor(value.targets[k]!/60)).padStart(2,'0')+':'+String(value.targets[k]!%60).padStart(2,'0')} onChange={e=>edit(v=>({...v,targets:{...v.targets,[k]:e.target.value?Number(e.target.value.slice(0,2))*60+Number(e.target.value.slice(3)):null}}))}/></label>)}
      </section>
      <section><h2>确认与内容范围</h2><p>可只保存草稿；只有确认版本能作为未来报告来源。编辑后重新成为草稿，不改写已发邮件。</p><p>当前：{value.state==='confirmed'?'已确认':'草稿'} · 云端基础版本 {draft.baseRevision}{draft.dirty?' · 本机有修改':''}</p>
        <details><summary>预览选定邮件内容</summary><pre>{preview('email')}</pre></details><details><summary>预览选定 AI 输入（尚不调用）</summary><pre>{preview('ai')}</pre></details>
        <div className="checkin-actions"><button type="button" disabled={!configured||conflict} onClick={()=>void save('draft')}>保存云端草稿</button><button type="button" disabled={!configured||conflict||value.items.some(i=>!i.name.trim())||value.meals.some(m=>!m.description.trim())} onClick={()=>void save('confirmed')}>确认并保存</button><button type="button" disabled={!configured} onClick={()=>void compare()}>读取云端版本比较</button></div>
      </section>
    </div></fieldset>
    {conflict&&<section className="checkin-conflict"><h2>版本比较</h2><p>本机草稿保持不变。请先读取最新云端版本，再比较内容。合并后仍需点击确认并保存。</p><pre>{compareRevision===null?'尚未读取最新版本':JSON.stringify(cloud?.value??null,null,2)}</pre><button type="button" disabled={busy||compareRevision===null} onClick={()=>{if(compareRevision===null)return;const next={...draftRef.current,baseRevision:compareRevision,clientKey:crypto.randomUUID(),dirty:true};set(next);setConflict(false);void persist(next);}}>已比较，保留本机内容并采用此基础版本</button></section>}
    {!!history.length&&<section><h2>已保存日期</h2><p>在上方选择日期查看或补记。最近 {history.length} 天有保存记录：</p><p>{history.map(h=>h.date).join(' · ')}</p></section>}
    {!!copies.length&&<section><h2>本机草稿副本</h2><p>各编辑页面独立保留，可能已被后续版本替代。选择只恢复到本页，不自动提交或覆盖云端。</p>{copies.map(copy=><button type="button" key={copy.editor} disabled={busy||localBlocked} onClick={()=>{try{const candidate={...copy.draft,value:checkinValue(copy.draft.value,date)};checkinKey(candidate.clientKey);set(candidate);setConflict(true);setCompareRevision(null);setCloud(null);void persist(candidate);setMessage('已恢复所选草稿副本，请读取云端版本比较后再保存');}catch{setMessage('此草稿需要进一步核对，未覆盖当前内容');}}}>{new Date(copy.updatedAt).toLocaleTimeString('zh-CN')} · {copy.draft.value.items.length} 项 / {copy.draft.value.meals.length} 条饮食</button>)}</section>}
    <section><h2>当日更正历史</h2><p>保留最近十个云端版本；查看不会覆盖当前草稿。</p><button type="button" disabled={busy||!configured||localBlocked} onClick={()=>{setBusy(true);void request<{ownerId:number;date:string;items:typeof revisions}>('/life/checkins/'+date+'/revisions').then(r=>{if(r.ownerId!==owner||r.date!==date)throw Error('历史所属不符');setRevisions(r.items);}).catch(()=>{if(current())setMessage('更正历史读取失败，当前草稿保留');}).finally(()=>{if(current())setBusy(false);});}}>读取当日历史</button>{revisions.map(r=><details key={r.revision}><summary>版本 {r.revision} · {new Date(r.updatedAt*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</summary><pre>{JSON.stringify(r.record,null,2)}</pre></details>)}</section>
  </div>;
}
function Scopes({email,ai,change}:{email:boolean;ai:boolean;change:(p:{email?:boolean;ai?:boolean})=>void}){return <div className="checkin-scopes"><label><input type="checkbox" checked={email} onChange={e=>change({email:e.target.checked})}/>纳入本人邮件</label><label><input type="checkbox" checked={ai} onChange={e=>change({ai:e.target.checked})}/>允许此项 AI 分析</label></div>;}
