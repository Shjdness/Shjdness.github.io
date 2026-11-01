import {useEffect,useRef,useState} from 'react';
import {getCookie} from 'typescript-cookie';
import {endpoint} from '../../main';
import {reportSnapshot,type LifeReportPreview} from '../../../../server/src/utils/life-report';

type Preferences={dailyTime:string;weeklyTime:string;weeklyDay:number;revision:number};
type Item={id:number;kind:'daily'|'weekly';period_start:number;period_end:number;created_at:number};
type Status={deepseekConfigured:boolean;apiVerified:boolean;aiEnabled:boolean;emailEnabled:boolean;automationEnabled:boolean;monthlyBudgetFen:number};

export function ReportWorkspace({ownerId,token,kind,historical,onSelect}:{ownerId:number;token:string;kind:'daily'|'weekly';historical:boolean;onSelect:(report:LifeReportPreview)=>void}){
  const [preferences,setPreferences]=useState<Preferences|null>(null);
  const [status,setStatus]=useState<Status|null>(null);
  const [items,setItems]=useState<Item[]>([]),[next,setNext]=useState<string|null>(null);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[message,setMessage]=useState('');
  const mounted=useRef(true),controllers=useRef(new Set<AbortController>());
  const current=()=>mounted.current&&getCookie('token')===token;
  const request=async<T,>(path:string,body?:unknown):Promise<T>=>{
    if(!current())throw Error('账号已切换，请重新登录后查看');
    const controller=new AbortController();controllers.current.add(controller);
    const timer=window.setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch(`${endpoint}/life/reports${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,cache:'no-store',credentials:'omit'});
      if(!response.ok)throw Error(response.status===409?'设置已在其他页面更新，请重新加载设置后核对':response.status===429?'操作过于频繁，请稍后重试':response.status===503?'暂时无法完成操作，请稍后重试':'操作未完成，请重试');
      const value=await response.json();
      if(!current()||controller.signal.aborted)throw Error('账号变化或请求已取消');
      if(value?.ownerId!==ownerId)throw Error('响应账号不匹配');
      return value as T;
    }catch(error){
      if(controller.signal.aborted)throw Error('请求超时或已取消，请重试');
      throw error;
    }finally{window.clearTimeout(timer);controllers.current.delete(controller);}
  };
  const history=async(before?:string)=>{
    const result=await request<{items:Item[];nextBefore:string|null}>('/history'+(before?`?before=${encodeURIComponent(before)}`:''));
    if(!Array.isArray(result.items)||result.items.some(item=>!Number.isSafeInteger(item.id)||item.id<1))throw Error('历史列表格式错误');
    if(current()){setItems(old=>before?[...old,...result.items.filter(item=>!old.some(value=>value.id===item.id))]:result.items);setNext(result.nextBefore);}
  };
  const load=async()=>{
    const [settings,state]=await Promise.all([request<{preferences:Preferences}>('/settings'),request<Status>('/status'),history()]);
    if(current()){setPreferences(settings.preferences);setStatus(state);}
  };
  useEffect(()=>{
    mounted.current=true;let active=true;
    void load().catch(()=>{if(active&&current())setMessage('暂时无法加载历史与设置，请重试');}).finally(()=>{if(active&&current())setLoading(false);});
    return()=>{active=false;mounted.current=false;for(const controller of controllers.current)controller.abort();};
  },[]);
  const run=async(action:()=>Promise<void>)=>{
    if(busy||loading)return;setBusy(true);setMessage('');
    try{await action();}catch(error){if(current())setMessage(error instanceof Error?error.message:'操作未完成，请重试');}
    finally{if(current())setBusy(false);}
  };
  const select=async(id:number)=>{
    const saved=await request<{report:LifeReportPreview}>(`/history/${id}`);
    const report=reportSnapshot(ownerId,saved.report);
    if(current()){onSelect(report);setMessage('正在查看已保存的统计快照。');}
  };
  const save=async()=>{
    const saved=await request<{saved:boolean;created:boolean;report:LifeReportPreview}>('/history',{kind});
    if(saved.saved!==true)throw Error('服务器未确认保存');
    const report=reportSnapshot(ownerId,saved.report);
    await history();
    if(current()){onSelect(report);setMessage(saved.created?'已保存本周期报告，后续源记录变化不会改写此快照。':'本周期已有报告，已打开原始快照，没有重复保存。');}
  };
  const saveSettings=async()=>{
    if(!preferences)return;
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(preferences.dailyTime)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(preferences.weeklyTime))throw Error('请填写完整的小时和分钟后再保存');
    const result=await request<{saved:boolean;preferences:Preferences}>('/settings',{dailyTime:preferences.dailyTime,weeklyTime:preferences.weeklyTime,weeklyDay:preferences.weeklyDay,baseRevision:preferences.revision});
    if(result.saved!==true)throw Error('设置未保存');
    if(current()){setPreferences(result.preferences);setMessage('时间设置已保存；定时生成、邮件和 AI 尚未启用。');}
  };
  const setTime=(field:'dailyTime'|'weeklyTime',value:string)=>setPreferences(current=>current?{...current,[field]:value}:current);
  return <section className="life-report-explanation life-report-workspace">
    <header><h2>报告历史与提醒设置</h2><button type="button" disabled={busy||loading||historical} onClick={()=>void run(save)}>保存当前{kind==='daily'?'日报':'周报'}</button></header>
    {loading&&<p role="status">正在加载历史与设置…</p>}
    {message&&<p role="status">{message}</p>}
    {!loading&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{await load();if(current())setMessage('已重新加载历史与设置。');})}>重新加载历史与设置</button>}
    <p>历史快照只保留当时已同步的统计，不包含日记或任务正文。</p>
    <ul className="life-report-history">{items.map(item=><li key={item.id}><button type="button" disabled={busy} onClick={()=>void run(()=>select(item.id))}>{item.kind==='daily'?'日报':'周报'} · {new Date(item.period_start*1000).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})} 起</button></li>)}</ul>
    {!loading&&!items.length&&<p>还没有保存报告，可以先保存一份当前完整周期的快照。</p>}
    {next&&<button type="button" disabled={busy} onClick={()=>void run(()=>history(next))}>查看更多历史</button>}
    {preferences&&<fieldset disabled={busy||loading} className="life-report-settings"><legend>时间设置（北京时间）</legend>
      <label>日报时间<input type="time" value={preferences.dailyTime} onInput={event=>setTime('dailyTime',event.currentTarget.value)} onChange={event=>setTime('dailyTime',event.target.value)}/></label>
      <label>周报时间<input type="time" value={preferences.weeklyTime} onInput={event=>setTime('weeklyTime',event.currentTarget.value)} onChange={event=>setTime('weeklyTime',event.target.value)}/></label>
      <label>周报日期<select value={preferences.weeklyDay} onChange={event=>{const value=Number(event.target.value);setPreferences(current=>current?{...current,weeklyDay:value}:current);}}>{['一','二','三','四','五','六','日'].map((day,index)=><option key={day} value={index+1}>星期{day}</option>)}</select></label>
      <button type="button" onClick={()=>void run(saveSettings)}>保存时间设置</button>
    </fieldset>}
    {status&&<p className="life-reports-notice">DeepSeek 密钥：{status.deepseekConfigured?'已配置（尚未验证 API 有效性）':'未配置'}。AI 仅允许统计数字，网站月预算 {status.monthlyBudgetFen/100} 元。定时生成、AI 分析与邮件发送均尚未启用，保存设置不会触发调用。</p>}
  </section>;
}
