import {useEffect,useRef,useState} from 'react';
import {analysisValue,type ReportAnalysis} from '../../../../server/src/utils/report-analysis-format';
import {getCookie} from 'typescript-cookie';
import {endpoint} from '../../main';
import {reportSnapshot,type LifeReportPreview} from '../../../../server/src/utils/life-report';

type Preferences={dailyTime:string;weeklyTime:string;weeklyDay:number;revision:number;dailyEnabled:boolean;weeklyEnabled:boolean};
type Item={id:number;kind:'daily'|'weekly';period_start:number;period_end:number;created_at:number};
type Status={deepseekConfigured:boolean;apiVerified:boolean;aiEnabled:boolean;emailEnabled:boolean;automationEnabled:boolean;monthlyBudgetFen:number;reservedMonthlyFen:number;manualAIAvailable:boolean;schedulerAvailable:boolean};
type AnalysisState={state:'none'|'pending'|'succeeded'|'statistics'|'unknown';analysis:ReportAnalysis|null;reason:string|null};

export function ReportWorkspace({ownerId,token,kind,historical,onSelect}:{ownerId:number;token:string;kind:'daily'|'weekly';historical:boolean;onSelect:(report:LifeReportPreview)=>void}){
  const [activeSaved,setActiveSaved]=useState<number|null>(null),[analysis,setAnalysis]=useState<AnalysisState|null>(null),[numericConsent,setNumericConsent]=useState(false);
  useEffect(()=>{if(!historical){setActiveSaved(null);setAnalysis(null);setNumericConsent(false);}},[historical,kind]);
  const [automationDraft,setAutomationDraft]=useState({dailyEnabled:false,weeklyEnabled:false});
  const [jobs,setJobs]=useState<Array<{kind:string;period_start:number;state:string;attempts:number}>>([]);
  const [preferences,setPreferences]=useState<Preferences|null>(null);
  const [status,setStatus]=useState<Status|null>(null);
  const [items,setItems]=useState<Item[]>([]),[next,setNext]=useState<string|null>(null);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[message,setMessage]=useState('');
  const mounted=useRef(true),controllers=useRef(new Set<AbortController>());
  const current=()=>mounted.current&&getCookie('token')===token;
  const request=async<T,>(path:string,body?:unknown):Promise<T>=>{
    if(!current())throw Error('账号已切换，请重新登录后查看');
    const controller=new AbortController();controllers.current.add(controller);
    const timer=window.setTimeout(()=>controller.abort(),body!==undefined&&path.endsWith('/analysis')?30000:15000);
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
  const loadJobs=async()=>{
    const result=await request<{items:Array<{kind:string;period_start:number;state:string;attempts:number}>}>('/jobs');
    if(!Array.isArray(result.items))throw Error('任务列表格式错误');
    if(current())setJobs(result.items);
  };
  const load=async()=>{
    const [settings,state]=await Promise.all([request<{preferences:Preferences}>('/settings'),request<Status>('/status'),history(),loadJobs()]);
    if(current()){setPreferences(settings.preferences);setAutomationDraft({dailyEnabled:settings.preferences.dailyEnabled,weeklyEnabled:settings.preferences.weeklyEnabled});setStatus(state);}
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
  const loadAnalysis=async(id:number)=>{
    const value=await request<AnalysisState&{reportId:number}>(`/history/${id}/analysis`);
    if(value.reportId!==id)throw Error('分析报告不匹配');
    const checked=value.state==='succeeded'?analysisValue(value.analysis):null;
    if(current())setAnalysis({...value,analysis:checked});
  };
  const select=async(id:number)=>{
    const saved=await request<{report:LifeReportPreview}>(`/history/${id}`);
    const report=reportSnapshot(ownerId,saved.report);
    if(current()){setActiveSaved(id);setAnalysis(null);setNumericConsent(false);onSelect(report);setMessage('正在查看已保存的统计快照。');}
    await loadAnalysis(id);
  };
  const save=async()=>{
    const saved=await request<{id:number;saved:boolean;created:boolean;report:LifeReportPreview}>('/history',{kind});
    if(saved.saved!==true||!Number.isSafeInteger(saved.id)||saved.id<1)throw Error('服务器未确认保存');
    const report=reportSnapshot(ownerId,saved.report);
    await history();
    if(current()){setActiveSaved(saved.id);setAnalysis(null);setNumericConsent(false);onSelect(report);setMessage(saved.created?'已保存本周期报告，后续源记录变化不会改写此快照。':'本周期已有报告，已打开原始快照，没有重复保存。');}
    await loadAnalysis(saved.id);
  };
  const analyze=async()=>{
    if(!activeSaved||!numericConsent||!status?.manualAIAvailable)return;
    const id=activeSaved;
    setAnalysis({state:'pending',analysis:null,reason:null});
    try{
      const value=await request<AnalysisState&{reportId:number}>(`/history/${id}/analysis`,{allowNumericAnalysis:true});
      if(value.reportId!==id)throw Error('分析报告不匹配');
      const checked=value.state==='succeeded'?analysisValue(value.analysis):null;
      if(current()){setAnalysis({...value,analysis:checked});setNumericConsent(false);}
      const state=await request<Status>('/status');if(current())setStatus(state);
    }catch{throw Error('分析请求结果尚未确认，请先重新读取结果；系统不会自动重复调用。');}
  };
  const saveSettings=async()=>{
    if(!preferences)return;
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(preferences.dailyTime)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(preferences.weeklyTime))throw Error('请填写完整的小时和分钟后再保存');
    const result=await request<{saved:boolean;preferences:Preferences}>('/settings',{dailyTime:preferences.dailyTime,weeklyTime:preferences.weeklyTime,weeklyDay:preferences.weeklyDay,baseRevision:preferences.revision});
    if(result.saved!==true)throw Error('设置未保存');
    if(current()){setPreferences(result.preferences);setMessage('时间设置已保存；自动生成按已保存开关执行，保存时间不会调用 AI 或发送邮件。');}
  };
  const saveAutomation=async()=>{
    if(!preferences)return;
    const result=await request<{saved:boolean;preferences:Preferences}>('/automation',{...automationDraft,baseRevision:preferences.revision});
    if(!result.saved)throw Error('自动生成设置未保存');
    if(current()){
      setPreferences(old=>old?{...old,revision:result.preferences.revision,dailyEnabled:result.preferences.dailyEnabled,weeklyEnabled:result.preferences.weeklyEnabled}:result.preferences);
      setAutomationDraft({dailyEnabled:result.preferences.dailyEnabled,weeklyEnabled:result.preferences.weeklyEnabled});
      setStatus(old=>old?{...old,automationEnabled:result.preferences.dailyEnabled||result.preferences.weeklyEnabled}:old);
      setMessage('自动生成设置已保存；AI 和邮件由各自的设置控制。已暂停的当期任务不补发。');
    }
    await loadJobs();
  };
  const setTime=(field:'dailyTime'|'weeklyTime',value:string)=>setPreferences(current=>current?{...current,[field]:value}:current);
  return <section className="life-report-explanation life-report-workspace">
    <header><h2>报告历史与提醒设置</h2><button type="button" disabled={busy||loading||historical} onClick={()=>void run(save)}>保存当前{kind==='daily'?'日报':'周报'}</button></header>
    {loading&&<p role="status">正在加载历史与设置…</p>}
    {message&&<p role="status">{message}</p>}
    {!loading&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{await load();if(current())setMessage('已重新加载历史与设置。');})}>重新加载历史与设置</button>}
    <p>历史快照只保留当时已同步的统计，不包含日记或任务正文。</p>
    <ul className="life-report-history">{items.map(item=><li key={item.id}><button type="button" disabled={busy} aria-pressed={activeSaved===item.id} onClick={()=>void run(()=>select(item.id))}>{item.kind==='daily'?'日报':'周报'} · {new Date(item.period_start*1000).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})} 起</button></li>)}</ul>
    {!loading&&!items.length&&<p>还没有保存报告，可以先保存一份当前完整周期的快照。</p>}
    {next&&<button type="button" disabled={busy} onClick={()=>void run(()=>history(next))}>查看更多历史</button>}
    {historical&&activeSaved&&<section className="life-report-analysis" aria-label="统计数字分析">
      <h3>这份报告的 AI 复盘</h3>
      <p>只发送成果、待办、专注、习惯与便签天数等统计数字，不发送正文、名称、日期、邮箱或账号。</p>
      {analysis?.state==='succeeded'&&analysis.analysis&&<div><p>{analysis.analysis.summary}</p><h4>观察</h4><ul>{analysis.analysis.observations.map((text,i)=><li key={i}>{text}</li>)}</ul><h4>可选的小行动</h4><ul>{analysis.analysis.actions.map((text,i)=><li key={i}>{text}</li>)}</ul><small>AI 根据有限统计提供参考，可能有误；不会修改你的记录。</small></div>}
      {analysis?.state==='pending'&&<p role="status">请求处理中，或仍在等待确认。请重新读取结果，不会重复提交。</p>}
      {analysis?.state==='unknown'&&<p role="status">上次请求结果未确认，已停止自动重试并保留预算预留。统计报告仍可使用。</p>}
      {analysis?.state==='statistics'&&<p>本次保留统计版；预算已满或已有调用记录，不会重复请求。</p>}
      {analysis?.state==='none'&&<>
        <label><input type="checkbox" checked={numericConsent} disabled={busy||!status?.manualAIAvailable} onChange={event=>setNumericConsent(event.target.checked)}/>允许仅用这份报告的统计数字进行本次分析</label>
        <button type="button" disabled={busy||!numericConsent||!status?.manualAIAvailable} onClick={()=>void run(analyze)}>分析这份报告（预算内）</button>
        {analysis.reason&&<p>{analysis.reason==='pricing-review'?'价格需要复核，暂时只保留统计版。':analysis.reason==='write-budget'?'今日写入预算已满，暂时保留统计版。':'尚未调用 AI。'}</p>}
      </>}
      <button type="button" disabled={busy} onClick={()=>void run(()=>loadAnalysis(activeSaved))}>重新读取分析结果</button>
    </section>}
    {preferences&&<fieldset disabled={busy||loading} className="life-report-settings"><legend>时间设置（北京时间）</legend>
      <label>日报时间<input type="time" value={preferences.dailyTime} onInput={event=>setTime('dailyTime',event.currentTarget.value)} onChange={event=>setTime('dailyTime',event.target.value)}/></label>
      <label>周报时间<input type="time" value={preferences.weeklyTime} onInput={event=>setTime('weeklyTime',event.currentTarget.value)} onChange={event=>setTime('weeklyTime',event.target.value)}/></label>
      <label>周报日期<select value={preferences.weeklyDay} onChange={event=>{const value=Number(event.target.value);setPreferences(current=>current?{...current,weeklyDay:value}:current);}}>{['一','二','三','四','五','六','日'].map((day,index)=><option key={day} value={index+1}>星期{day}</option>)}</select></label>
      <button type="button" onClick={()=>void run(saveSettings)}>保存时间设置</button>
    </fieldset>}
    {preferences&&<fieldset disabled={busy||loading||!status?.schedulerAvailable} className="life-report-automation"><legend>自动保存统计报告</legend>
      <label><input type="checkbox" checked={automationDraft.dailyEnabled} onChange={event=>{const checked=event.target.checked;setAutomationDraft(old=>({...old,dailyEnabled:checked}));}}/>自动保存日报</label>
      <label><input type="checkbox" checked={automationDraft.weeklyEnabled} onChange={event=>{const checked=event.target.checked;setAutomationDraft(old=>({...old,weeklyEnabled:checked}));}}/>自动保存周报</label>
      <p>北京时间每日 05:00 起固定采集昨日已同步记录，周报采集完整上周并合并昨日日报；发送仍按上方时间执行。云端每 5 分钟检查一次，实际采集时刻写入报告。05:00 后的补记不改写已固定报告；未同步的本机记录不在其中。若发送时间早于 05:00，将等待采集完成；已暂停任务不重放。</p>
      <p>本开关只控制站内统计保存；AI 分析与邮件提醒需要分别明确启用。</p>
      <button type="button" onClick={()=>void run(saveAutomation)}>保存自动生成设置</button>
    </fieldset>}
    <section className="life-report-job-list"><h3>最近自动任务</h3>{jobs.length?<ul>{jobs.map((job,i)=><li key={i}>{job.kind==='weekly'?'周报':'日报'} · {new Date(job.period_start*1000).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})} · {({queued:'等待生成',generating:'正在生成',ready:'统计已保存',paused:'已暂停',failed:'生成失败'} as Record<string,string>)[job.state]??'状态待确认'}{job.attempts>0?`（${job.attempts} 次尝试）`:''}</li>)}</ul>:<p>暂无自动任务；开启后按设置时刻检查生成。</p>}</section>
    {status&&<p className="life-reports-notice">DeepSeek 密钥：{status.deepseekConfigured?'已配置（配置状态不代表当前 API 有效）':'未配置'}。网站月预算 {status.monthlyBudgetFen/100} 元，本月预留 {(status.reservedMonthlyFen/100).toFixed(2)} 元（预留额不等于实际账单）。手动 AI 需逐份勾选确认；自动统计保存{status.automationEnabled?'已开启':'未开启'}。自动 AI 和邮件状态请查看下方各自设置。</p>}
  </section>;
}
