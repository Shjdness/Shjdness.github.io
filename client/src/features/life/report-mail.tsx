import {useEffect,useRef,useState} from 'react';
import {getCookie} from 'typescript-cookie';
import {endpoint} from '../../main';
import {pendingReportVerification,clearReportVerification} from './report-verification';

type MailState={ownerId:number;storageConfigured:boolean;deliveryConfigured:boolean;feedbackMode?:'manual'|'webhook';maskedRecipient:string|null;contactRevision?:number;preferencesRevision?:number;verified:boolean;enabled:boolean;pausedReason?:string|null};
type Delivery={kind:string;state:string;created_at:number};
const labels:Record<string,string>={queued:'等待提交',submitting:'提交中，结果待确认',accepted:'服务已受理',delivered:'收件服务器已接收',rejected:'服务拒绝',unknown:'结果未知，不自动重发',bounced:'退信，已暂停',complained:'收件人反馈（投诉或退订），已暂停',paused:'已暂停'};

export function ReportMailSettings({ownerId,token}:{ownerId:number;token:string}){
  const [state,setState]=useState<MailState|null>(null),[items,setItems]=useState<Delivery[]>([]),[email,setEmail]=useState(''),[consent,setConsent]=useState(false);
  const [proof,setProof]=useState(()=>pendingReportVerification(ownerId)),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const mounted=useRef(true),locked=useRef(false),controllers=useRef(new Set<AbortController>());
  const current=()=>mounted.current&&getCookie('token')===token;
  const request=async<T,>(path:string,body?:unknown):Promise<T>=>{
    if(!current())throw Error('账号已变化，请重新打开本页');
    const controller=new AbortController();controllers.current.add(controller);const timer=window.setTimeout(()=>controller.abort(),20000);
    try{
      const response=await fetch(`${endpoint}/life/reports/mail${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),credentials:'omit',cache:'no-store',signal:controller.signal});
      if(!response.ok)throw Error(response.status===409?'状态已变化或验证码无效，请刷新核对；不要重复发送':response.status===429?'操作过于频繁，请稍后再试':response.status===503?'邮件服务暂不可用；未确认的发送不会自动重试':'操作未完成，请核对输入或登录状态');
      const result=await response.json();if(!current()||controller.signal.aborted)throw Error('请求已取消');
      if(result?.ownerId!==ownerId)throw Error('响应账号不匹配');return result as T;
    }finally{window.clearTimeout(timer);controllers.current.delete(controller);}
  };
  const load=async()=>{
    const [next,history]=await Promise.all([request<MailState>(''),request<{items:Delivery[]}>('/deliveries')]);
    if(!Array.isArray(history.items))throw Error('投递状态格式错误');
    if(current()){setState(next);setItems(history.items);setConsent(false);}
  };
  useEffect(()=>{
    mounted.current=true;let active=true;
    const receive=()=>{if(current())setProof(pendingReportVerification(ownerId));};
    window.addEventListener('report-verification-ready',receive);receive();
    void load().catch(()=>{if(active&&current())setMessage('邮件设置暂不可用，请刷新重试');});
    return()=>{active=false;mounted.current=false;window.removeEventListener('report-verification-ready',receive);for(const controller of controllers.current)controller.abort();};
  },[]);
  const run=async(action:()=>Promise<void>)=>{
    if(locked.current||!current())return;locked.current=true;setBusy(true);setMessage('');
    try{await action();}catch{if(current())setMessage('操作未获确认，请刷新状态核对。发送结果未知时请勿重复发送；验证失败可重新打开原邮件链接。');}
    finally{locked.current=false;if(current())setBusy(false);}
  };
  const save=()=>run(async()=>{
    if(!state||!email.trim())return;
    await request('/recipient',{email:email.trim(),baseRevision:state.contactRevision??0});
    if(current())setEmail('');await load();if(current())setMessage('地址已保存，尚未发送验证邮件。修改地址会关闭原提醒。');
  });
  const sendVerification=()=>run(async()=>{
    const result=await request<{state:string}>('/verification',{});await load();
    if(current())setMessage(result.state==='accepted'?'验证邮件已由服务受理，请查收；这不表示已送达。':result.state==='already-verified'?'邮箱已验证，可明确选择启用提醒。':'本次验证发送状态：'+(labels[result.state]??'未确认')+'。请先核对状态，不要重复提交。');
  });
  const verify=()=>run(async()=>{
    const tokenProof=proof;if(!tokenProof)return;clearReportVerification();setProof(null);
    const result=await request<{verified:boolean}>('/verify',{token:tokenProof});await load();
    if(current())setMessage(result.verified?'邮箱已验证。邮件提醒仍需你单独启用。':'验证未完成，请重新打开原验证链接。');
  });
  const enable=(enabled:boolean)=>run(async()=>{
    if(!state||enabled&&!consent)return;
    const result=await request<{saved:boolean}>('/enabled',{enabled,contactRevision:state.contactRevision??0,baseRevision:state.preferencesRevision??0});
    if(!result.saved)throw Error();await load();if(current())setMessage(enabled?'已启用，按已开启的日/周报计划发送；不补发过去的任务。':'已暂停后续发送；已交给邮件服务的消息无法撤回。');
  });
  return <section className="life-report-explanation life-report-workspace life-report-mail" aria-labelledby="report-mail-title">
    <header><h2 id="report-mail-title">邮件提醒</h2><button type="button" disabled={busy} onClick={()=>void run(load)}>刷新邮件状态</button></header>
    <p>先保存并验证邮箱，再明确启用。邮件只含统计与已有数字分析，不发送日记正文或任务名称；验证和发送均不会因打开此页自动触发。</p>
    {state&&!state.storageConfigured&&<p>邮件配置尚未就绪，当前无法保存新地址或发送邮件。</p>}
    {state?.feedbackMode==='manual'&&<p>QQ 邮箱通道：服务已受理只表示 QQ 服务器接受提交，不代表收件箱已收到。此通道没有自动送达或退信回调，需查收邮件；未收到时先核对收件箱、垃圾箱及发件邮箱退信，可在这里暂停。</p>}
    {state&&<p>收件地址：{state.maskedRecipient??(state.contactRevision?'配置暂不可读取':'尚未配置')} · {state.verified?'已验证':'未验证'} · {state.enabled?'提醒已启用':'提醒已关闭'}{state.pausedReason?' · 退信或收件人反馈后暂停':''}</p>}
    <form onSubmit={event=>{event.preventDefault();void save();}} className="life-report-mail-form">
      <label htmlFor="report-recipient">新的收件邮箱</label><input id="report-recipient" type="email" autoComplete="off" maxLength={254} value={email} disabled={busy||!state?.storageConfigured} onChange={event=>setEmail(event.target.value)} placeholder="输入邮箱，保存后仅显示掩码"/>
      <button disabled={busy||!state?.storageConfigured||!email.trim()}>保存地址</button>
    </form>
    <div className="life-report-mail-actions"><button type="button" disabled={busy||!state?.deliveryConfigured||!state.maskedRecipient||state.verified||Boolean(state.pausedReason)} onClick={()=>void sendVerification()}>发送验证邮件</button>
      {proof&&<button type="button" disabled={busy||!state?.storageConfigured} onClick={()=>void verify()}>确认当前账号的邮箱验证</button>}
    </div>
    <p>验证链接只在本页内存中保留；如先登录或重新加载后验证码丢失，请再打开原邮件链接。邮箱验证不代表邮件已启用。</p>
    {!state?.enabled&&<label className="life-report-mail-consent"><input type="checkbox" checked={consent} disabled={busy||!state?.verified||!state.deliveryConfigured||Boolean(state.pausedReason)} onChange={event=>setConsent(event.target.checked)}/>我同意按已开启的日报/周报计划接收统计邮件，可随时暂停</label>}
    <div className="life-report-mail-actions"><button type="button" disabled={busy||!consent||!state?.verified||!state.deliveryConfigured||state.enabled||Boolean(state.pausedReason)} onClick={()=>void enable(true)}>启用邮件提醒</button><button type="button" disabled={busy||!state} onClick={()=>void enable(false)}>暂停邮件提醒</button></div>
    {message&&<p role="status">{message}</p>}
    <details><summary>最近投递状态</summary><p>服务受理、收件服务器接收与本人已读是不同状态；本站不跟踪已读。结果未知时不会自动重发。</p>{items.length?<ul>{items.map((item,index)=><li key={index}>{new Date(item.created_at*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} · {item.kind==='verification'?'邮箱验证':'统计报告'} · {labels[item.state]??'状态待确认'}</li>)}</ul>:<p>暂无投递记录。</p>}</details>
  </section>;
}
