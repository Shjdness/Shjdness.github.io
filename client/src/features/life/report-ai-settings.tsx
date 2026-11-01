import {useEffect,useRef,useState} from 'react';
import {getCookie} from 'typescript-cookie';
import {endpoint} from '../../main';
type AISettings={ownerId:number;enabled:boolean;revision:number;enabledAt:number|null;scope:'statistics';configured:boolean;pricingValid:boolean;monthlyBudgetFen:number;reservedMonthlyFen:number};
export function ReportAISettings({ownerId,token}:{ownerId:number;token:string}){
  const [state,setState]=useState<AISettings|null>(null),[consent,setConsent]=useState(false),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const alive=useRef(true),lock=useRef(false),controllers=useRef(new Set<AbortController>());
  const current=()=>alive.current&&getCookie('token')===token;
  const request=async(body?:unknown)=>{
    if(!current())throw Error();const controller=new AbortController();controllers.current.add(controller);const timer=window.setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch(`${endpoint}/life/reports/ai-automation`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'omit',signal:controller.signal});
      if(!response.ok)throw Error(response.status===409?'设置已变化，请刷新后核对；当前勾选不会覆盖其他页面的设置。':'操作未获确认，请刷新核对；不会自动重试。');
      const value=await response.json();if(!current()||controller.signal.aborted||value?.ownerId!==ownerId)throw Error('账号或请求状态已变化');return value;
    }finally{clearTimeout(timer);controllers.current.delete(controller);}
  };
  const load=async()=>{const next=await request();if(next.scope!=='statistics'||!Number.isSafeInteger(next.revision))throw Error('设置格式错误');if(current()){setState(next);setConsent(false);}};
  useEffect(()=>{
    alive.current=true;let active=true;void load().catch(()=>{if(active&&current())setMessage('自动分析设置暂不可用，请刷新重试。');});
    return()=>{active=false;alive.current=false;for(const controller of controllers.current)controller.abort();};
  },[]);
  const run=async(action:()=>Promise<void>)=>{if(lock.current||!current())return;lock.current=true;setBusy(true);setMessage('');try{await action();}catch(error){if(current())setMessage(error instanceof Error?error.message:'操作未完成，请刷新核对');}finally{lock.current=false;if(current())setBusy(false);}};
  const save=async(enabled:boolean)=>{
    if(!state||enabled&&!consent)return;const result=await request({enabled,baseRevision:state.revision,...(enabled?{allowNumericAnalysis:true}:{})});if(!result.saved)throw Error('设置未确认');
    // A successful withdrawal remains visible even if a subsequent status read
    // fails; this never pretends an unacknowledged request has succeeded.
    if(current()){setState(old=>old?{...old,enabled:result.enabled,revision:result.revision,enabledAt:result.enabledAt}:old);setConsent(false);setMessage(enabled?'已允许后续日/周报自动分析统计数字，不补做之前的报告。':'已暂停新的自动分析；此前已提交的请求不能撤回，已有结果保留。');}
  };
  return <section className="life-report-explanation life-report-workspace life-report-analysis" aria-labelledby="report-auto-ai-title">
    <header><h2 id="report-auto-ai-title">自动数字复盘</h2><button type="button" disabled={busy} onClick={()=>void run(load)}>刷新自动分析设置</button></header>
    <p>单独允许后，已开启的日报/周报会自动分析统计数字。不会发送正文、名称、日期、邮箱或账号；周报合并的日报附录只保留统计，不另作一次 AI 调用。</p>
    {state&&<><p>当前：{state.enabled?'已允许自动分析':'自动分析已关闭'}。网站共享月预算 {state.monthlyBudgetFen/100} 元，本月已预留 {(state.reservedMonthlyFen/100).toFixed(2)} 元；预留不等于供应商账单。预算不足、失败或配置不可用时保留统计版，不加预算或自动重试。</p>
      {!state.configured&&<p>DeepSeek 密钥尚未配置；可以暂停，暂不能启用。</p>}{!state.pricingValid&&<p>价格需要复核，自动调用已停止；统计报告仍可使用。</p>}
      {!state.enabled&&<label><input type="checkbox" checked={consent} disabled={busy||!state.configured||!state.pricingValid} onChange={event=>setConsent(event.target.checked)}/>我持续允许后续日/周报仅向 DeepSeek 提交统计数字，费用受网站每月10元上限控制，可随时暂停</label>}
      <button type="button" disabled={busy||state.enabled||!consent||!state.configured||!state.pricingValid} onClick={()=>void run(()=>save(true))}>允许自动数字分析</button><button type="button" disabled={busy} onClick={()=>void run(()=>save(false))}>暂停自动数字分析</button>
      <p>本设置不会开启日报/周报计划或邮件提醒。暂停只影响新的自动调用，手动分析仍需逐份确认；恢复后从新同意时刻起处理，不追补旧任务。</p></>}
    {message&&<p role="status">{message}</p>}
  </section>;
}
