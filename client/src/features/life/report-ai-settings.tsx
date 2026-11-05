import {useEffect,useRef,useState} from 'react';
import {getCookie} from 'typescript-cookie';
import {endpoint} from '../../main';
type AISettings={ownerId:number;enabled:boolean;revision:number;enabledAt:number|null;scope:'statistics'|'selected';configured:boolean;paused?:boolean;pricingValid:boolean;monthlyBudgetFen:number;reservedMonthlyFen:number};
export function ReportAISettings({ownerId,token,selected=false}:{ownerId:number;token:string;selected?:boolean}){
  const [state,setState]=useState<AISettings|null>(null),[consent,setConsent]=useState(false),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const alive=useRef(true),lock=useRef(false),controllers=useRef(new Set<AbortController>());
  const current=()=>alive.current&&getCookie('token')===token;
  const request=async(body?:unknown)=>{
    if(!current())throw Error();const controller=new AbortController();controllers.current.add(controller);const timer=window.setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch(`${endpoint}/life/reports/${selected?'selected-ai':'ai-automation'}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'omit',signal:controller.signal});
      if(!response.ok)throw Error(response.status===409?'设置已变化，请刷新后核对；当前勾选不会覆盖其他页面的设置。':'操作未获确认，请刷新核对；不会自动重试。');
      const value=await response.json();if(!current()||controller.signal.aborted||value?.ownerId!==ownerId)throw Error('账号或请求状态已变化');return value;
    }finally{clearTimeout(timer);controllers.current.delete(controller);}
  };
  const load=async()=>{const next=await request();if(next.scope!==(selected?'selected':'statistics')||!Number.isSafeInteger(next.revision))throw Error('设置格式错误');if(current()){setState(next);setConsent(false);}};
  useEffect(()=>{
    alive.current=true;let active=true;void load().catch(()=>{if(active&&current())setMessage('自动分析设置暂不可用，请刷新重试。');});
    return()=>{active=false;alive.current=false;for(const controller of controllers.current)controller.abort();};
  },[]);
  const run=async(action:()=>Promise<void>)=>{if(lock.current||!current())return;lock.current=true;setBusy(true);setMessage('');try{await action();}catch(error){if(current())setMessage(error instanceof Error?error.message:'操作未完成，请刷新核对');}finally{lock.current=false;if(current())setBusy(false);}};
  const save=async(enabled:boolean)=>{
    if(!state||enabled&&!consent)return;const result=await request({enabled,baseRevision:state.revision,...(enabled?(selected?{allowSelectedAnalysis:true}:{allowNumericAnalysis:true}):{})});if(!result.saved)throw Error('设置未确认');
    // A successful withdrawal remains visible even if a subsequent status read
    // fails; this never pretends an unacknowledged request has succeeded.
    if(current()){setState(old=>old?{...old,enabled:result.enabled,revision:result.revision,enabledAt:result.enabledAt}:old);setConsent(false);setMessage(enabled?(selected?'已允许后续新采集报告分析选定的习惯、打卡、饮食与作息；不补做旧报告。':'已允许后续日/周报自动分析统计数字，不补做之前的报告。'):'已暂停新的自动分析；此前已提交的请求不能撤回，已有结果保留。');}
  };
  const label=selected?'选定生活记录分析':'自动数字复盘',heading=selected?'report-selected-ai-title':'report-auto-ai-title';
  return <section className="life-report-explanation life-report-workspace life-report-analysis" aria-labelledby={heading}>
    <header><h2 id={heading}>{label}</h2><button type="button" disabled={busy} onClick={()=>void run(load)}>刷新自动分析设置</button></header>
    <p>{selected?'单独允许后，只把生活复盘中勾选“允许 AI”的习惯、打卡名称/结果/备注、饮食描述/份量、作息钟点与目标交给 DeepSeek。不提交日记、便签、RSS、邮箱、账号或精确日期；未选项目不提交。日报可以参考近七天，周报不额外分析日报附录。':'单独允许后，已开启的日报/周报会自动分析统计数字。不会发送正文、名称、日期、邮箱或账号；周报合并的日报附录只保留统计，不另作一次 AI 调用。'}</p>
    {state&&<><p>当前：{state.enabled?'已允许自动分析':'自动分析已关闭'}。网站共享月预算 {state.monthlyBudgetFen/100} 元，本月已预留 {(state.reservedMonthlyFen/100).toFixed(2)} 元；预留不等于供应商账单。预算不足、失败或配置不可用时保留统计版，不加预算或自动重试。</p>
      {!state.configured&&<p>{selected?'AI 或生活记录加密配置未就绪':'DeepSeek 密钥尚未配置'}；可以暂停，暂不能启用。</p>}{!state.pricingValid&&<p>价格需要复核，自动调用已停止；统计报告仍可使用。</p>}
      {state.paused&&<p>维护期间外部调用已暂停。统计和历史仍可查看，也可以撤回自动分析同意。</p>}
      {!state.enabled&&<label><input type="checkbox" checked={consent} disabled={busy||state.paused||!state.configured||!state.pricingValid} onChange={event=>setConsent(event.target.checked)}/>{selected?'我持续允许 DeepSeek 分析本人勾选的四类生活记录，费用与其他分析共用网站每月10元上限，可随时暂停':'我持续允许后续日/周报仅向 DeepSeek 提交统计数字，费用受网站每月10元上限控制，可随时暂停'}</label>}
      <button type="button" disabled={busy||state.paused||state.enabled||!consent||!state.configured||!state.pricingValid} onClick={()=>void run(()=>save(true))}>{selected?'允许选定记录自动分析':'允许自动数字分析'}</button><button type="button" disabled={busy} onClick={()=>void run(()=>save(false))}>{selected?'暂停选定记录自动分析':'暂停自动数字分析'}</button>
      {selected&&<p>只有全部 AI 输入也允许“进入邮件”时，综合分析才可附入邮件；否则仅在站内查看。没有选定记录、预算不足、超时或失败时照常发事实版，不自动重试未知请求。建议可能不准确，不推断疾病、实际睡眠或营养数值。</p>}
      <p>本设置不会开启日报/周报计划或邮件提醒。暂停只影响新的自动调用，手动分析仍需逐份确认；恢复后从新同意时刻起处理，不追补旧任务。</p></>}
    {message&&<p role="status">{message}</p>}
  </section>;
}
