import {useContext,useEffect,useState} from 'react';
import {Link} from 'wouter';
import {getCookie} from 'typescript-cookie';
import {loadReportPreview,type LifeReportPreview} from './report-preview';
import {ProfileContext} from '../../state/profile';
import {accountIdFromToken} from '../../data/local-first';
import {endpoint} from '../../main';
import {LifeDenied,LifeLayout} from './layout';
import './reports.css';
import {ReportWorkspace} from './report-workspace';
import {ReportMailSettings} from './report-mail';

export function LifeReportsEntry(){
  const profile=useContext(ProfileContext);
  if(profile?.role!=='owner'||accountIdFromToken(getCookie('token'))!==profile.id)return null;
  return <section className="life-reports-entry"><div><small>REVIEW</small><h2>复盘与提醒</h2><p>回看昨日与上周，记住已经做成的事。</p></div><Link className="life-link" href="/life/reports">查看统计预览 →</Link></section>;
}

export function LifeReportsView(){
  const profile=useContext(ProfileContext);
  const [kind,setKind]=useState<'daily'|'weekly'>('daily');
  const [reload,setReload]=useState(0);
  const [result,setResult]=useState<{token:string;kind:string;report:LifeReportPreview}|null>(null);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);
  const [selected,setSelected]=useState<{token:string;report:LifeReportPreview}|null>(null);
  const token=getCookie('token');
  const owner=profile?.role==='owner'&&accountIdFromToken(token)===profile.id ? profile.id : null;

  useEffect(()=>{
    const refresh=()=>setReload(value=>value+1);
    const visible=()=>{if(document.visibilityState==='visible')refresh();};
    window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',visible);
    return()=>{window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',visible);};
  },[]);
  useEffect(()=>{
    setResult(null);setError('');
    if(!owner||!token){setLoading(false);return;}
    const controller=new AbortController();let active=true,timedOut=false;
    const timer=window.setTimeout(()=>{timedOut=true;controller.abort();},15000);
    setLoading(true);
    const current=()=>active&&getCookie('token')===token;
    void (async()=>{
      try{
        const report=await loadReportPreview({endpoint,token,ownerId:owner,kind,signal:controller.signal,currentToken:()=>getCookie('token')});
        if(current()&&!controller.signal.aborted)setResult({token,kind,report});
      }catch(reason){if(current())setError(timedOut?'读取超时，请重试':reason instanceof Error?reason.message:'读取失败，请重试');}
      finally{window.clearTimeout(timer);if(current())setLoading(false);}
    })();
    return()=>{active=false;window.clearTimeout(timer);controller.abort();};
  },[owner,token,kind,reload]);

  if(!owner)return <LifeDenied/>;
  const historical=Boolean(selected&&selected.token===token);
  const report=selected&&selected.token===token?selected.report:result&&result.token===token&&result.kind===kind?result.report:null;
  return <LifeLayout section="reports" title="复盘与提醒" intro="回看已记录的进展，让下一步更容易开始。">
    <div className="life-reports">
      <header className="life-reports-toolbar"><nav aria-label="报告类型"><button type="button" aria-pressed={kind==='daily'&&!historical} onClick={()=>{setSelected(null);setKind('daily');}}>昨日日报</button><button type="button" aria-pressed={kind==='weekly'&&!historical} onClick={()=>{setSelected(null);setKind('weekly');}}>上周周报</button></nav><button type="button" disabled={loading} onClick={()=>{setSelected(null);setReload(value=>value+1);}}>刷新统计</button><Link href="/life">返回 Life</Link></header>
      <p className="life-reports-notice">{historical?'当前为已保存的历史统计快照，不随源记录变化。':'当前为统计预览，尚未保存为历史报告。'}AI 仅在保存报告后明确选择时分析统计数字；邮件提醒需在下方验证并单独启用。</p>
      {loading&&!historical&&<p role="status">正在读取已同步记录…</p>}
      {error&&!historical&&<p role="alert">{error}</p>}
      {report&&<>
        <section className="life-report-period"><h2>{historical?'已保存的'+(report.period.kind==='daily'?'日报':'周报'):kind==='daily'?'昨日的生活记录':'上一个完整周的生活记录'}</h2><p>{report.period.fromDate} 起，至 {report.period.toDateExclusive} 前 · 北京时间</p><small>数据截至 {new Date(report.generatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</small></section>
        <div className="life-report-metrics">
          <Metric value={report.achievementsRecorded} label="记录的成果" detail={`其中 ${report.tasksCompleted} 项为完成的待办；两者不重复相加`}/>
          <Metric value={`${report.focus.recordedMinutes} 分钟`} label="已记录专注" detail={`${report.focus.completedSessions} 轮完成记录，其中 ${report.focus.earlySessions} 轮提前结束`}/>
          <Metric value={report.habitCompletions} label="习惯完成记录" detail="统计记录次数，不推算历史完成率"/>
          <Metric value={report.daysWithNotes} label="有日历便签的天数" detail="只统计非空便签，不展示或分析正文"/>
          <Metric value={report.ideasCreated} label="新增未来构想" detail="按当前仍在构想栏的记录统计"/>
        </div>
        <section className="life-report-explanation"><h2>给下一步留一点空间</h2><p>{report.achievementsRecorded>0?'已经记录的每一件小成果，都值得留下。可以回看其中一件，再选择接下来最容易开始的一步。':'这个周期没有新增的已记录成果。这不代表你没有行动，可以先记下一件最近做成的小事。'}</p><div><Link href="/life/todos">回到四栏工作台</Link><Link href="/life/pomodoro">开始一次专注</Link></div></section>
      </>}
      <ReportWorkspace key={token} ownerId={owner} token={token!} kind={kind} historical={historical} onSelect={report=>setSelected({token:token!,report})}/>
      <ReportMailSettings key={'mail-'+token} ownerId={owner} token={token!}/>
      <details className="life-report-explanation"><summary>统计范围</summary><p>只包含服务端已同步记录；本机尚未同步的内容不在其中。统计依据当前记录状态，不能重建已删除、撤销完成或移动栏目之前的全部历史。</p><p>每日执行是辅助记忆的清单，不计习惯打卡率。专注按结束时间归入周期，展示保存的分钟数，不等同于经过独立核验的实际用时。</p></details>
    </div>
  </LifeLayout>;
}

function Metric({value,label,detail}:{value:number|string;label:string;detail:string}){
  return <article><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}
