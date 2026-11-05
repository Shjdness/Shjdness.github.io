import {useEffect,useRef,useState} from 'react';
import {getCookie} from 'typescript-cookie';
import {endpoint} from '../../main';
type Settings={ownerId:number;scopeVersion:3;enabled:boolean;revision:number;enabledAt:number|null;configured:boolean;paused:boolean};
export function ReportBriefSettings({ownerId,token}:{ownerId:number;token:string}){
 const [state,setState]=useState<Settings|null>(null),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const alive=useRef(true),locked=useRef(false),pending=useRef(new Set<AbortController>());
 const current=()=>alive.current&&getCookie('token')===token;
 const request=async(body?:unknown)=>{
  if(!current())throw Error('账号已变化');const controller=new AbortController();pending.current.add(controller);const timer=setTimeout(()=>controller.abort(),15000);
  try{
   const response=await fetch(`${endpoint}/life/reports/brief-mail`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'omit',signal:controller.signal});
   if(!response.ok)throw Error(response.status===409?'设置已变化，请刷新核对后再操作。':'操作未确认，请刷新核对；不会自动重试。');
   const next=await response.json();if(!current()||controller.signal.aborted||next?.ownerId!==ownerId||next.scopeVersion!==3||!Number.isSafeInteger(next.revision))throw Error('账号或响应状态已变化');return next;
  }finally{clearTimeout(timer);pending.current.delete(controller);}
 };
 const load=async()=>{const next=await request();if(current()){setState(next);setConsent(false);}};
 useEffect(()=>{alive.current=true;let active=true;void load().catch(()=>{if(active&&current())setMessage('明细邮件设置暂不可用，请刷新。');});return()=>{active=false;alive.current=false;for(const c of pending.current)c.abort();};},[]);
 const run=async(action:()=>Promise<void>)=>{if(locked.current||!current())return;locked.current=true;setBusy(true);setMessage('');try{await action();}catch(error){if(current())setMessage(error instanceof Error?error.message:'操作未确认');}finally{locked.current=false;if(current())setBusy(false);}};
 const save=async(enabled:boolean)=>{
  if(!state||enabled&&!consent)return;
  const next=await request({enabled,baseRevision:state.revision,...(enabled?{allowNamedMail:true}:{})});if(!next.saved)throw Error('设置未确认');
  if(current()){setState(old=>old?{...old,enabled:next.enabled,revision:next.revision,enabledAt:next.enabledAt}:old);setConsent(false);setMessage(enabled?'已允许后续新采集报告使用完整邮件模板；不补发旧报告。':'已撤回明细邮件许可，尚未提交的明细将被拦截；已交给邮件服务的内容无法撤回。');}
 };
 return <section className="life-report-explanation life-report-workspace" aria-labelledby="brief-mail-title">
  <header><h2 id="brief-mail-title">完整日报与周报</h2><button type="button" disabled={busy} onClick={()=>void run(load)}>刷新明细设置</button></header>
  <p>邮件包含今日三件事、待办名称及剩余时间、RSS 分类与频道、昨日完成待办、习惯打卡和专注任务，以及明日安排。饮食作息与自选打卡仅包含你勾选“进入邮件”的项目；不包含日记和便签正文。</p>
  {state&&<><p>当前：{state.enabled?'允许完整明细邮件':'仅使用原统计邮件'}。本开关只允许发送到你已验证的邮箱，不授权任何 AI 分析。</p>
   {!state.configured&&<p>明细加密配置尚未就绪；仍可撤回许可，原统计邮件不受影响。</p>}{state.paused&&<p>外部发送维护暂停中；仍可撤回许可。</p>}
   {!state.enabled&&<label><input type="checkbox" checked={consent} disabled={busy||!state.configured||state.paused} onChange={e=>setConsent(e.target.checked)}/>我允许后续新采集的日报与周报将上述生活明细发送到本人已验证的邮箱，可随时撤回</label>}
   <button type="button" disabled={busy||state.enabled||!consent||!state.configured||state.paused} onClick={()=>void run(()=>save(true))}>允许完整明细邮件</button>
   <button type="button" disabled={busy} onClick={()=>void run(()=>save(false))}>撤回明细邮件许可</button>
   <p>启用此项不会开启邮件提醒或定时报告，请同时保留邮件提醒与日报/周报计划的启用状态。变更分享项目后，已准备的明细会被暂停，不自动替换正文重发。</p></>}
  {message&&<p role="status">{message}</p>}
 </section>;
}
