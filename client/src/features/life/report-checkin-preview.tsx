import {useEffect,useState} from 'react';
import {getCookie} from 'typescript-cookie';
import {Link} from 'wouter';
import {endpoint} from '../../main';
import {reportSnapshot} from '../../../../server/src/utils/life-report';
import {reportCheckinArchiveValue} from '../../../../server/src/utils/report-checkin-format';
import {frozenCheckinMailDraft} from '../../../../server/src/utils/checkin-report';
type View={text:string;current:boolean;archived:boolean}|null;
/** Read-only facts, never submits to a model or mail provider. Source admission
 * HMACs are intentionally stripped by the owner API before reaching the UI. */
export function ReportCheckinPreview({ownerId,token,reportId}:{ownerId:number;token:string;reportId:number}){
 const [view,setView]=useState<View>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[reload,setReload]=useState(0);
 useEffect(()=>{let active=true;const controller=new AbortController(),timer=window.setTimeout(()=>controller.abort(),15000);const current=()=>active&&getCookie('token')===token;
  setLoading(true);setView(null);setError('');
  void (async()=>{try{if(!current())return;const r=await fetch(`${endpoint}/life/reports/history/${reportId}/checkins`,{headers:{Authorization:`Bearer ${token}`},cache:'no-store',credentials:'omit',signal:controller.signal});if(!r.ok)throw Error(r.status===503?'生活复盘暂时无法解密，统计报告仍可查看':'暂时无法读取生活复盘快照');const result=await r.json();if(!current())return;if(result.ownerId!==ownerId||result.reportId!==reportId)throw Error('报告所属不匹配');if(result.details===null){setView(null);return;}
   const report=reportSnapshot(ownerId,result.report),snapshot=reportCheckinArchiveValue(result.details?.snapshot,report);if(typeof result.details.current!=='boolean'||typeof result.details.archived!=='boolean')throw Error('报告状态无效');setView({text:frozenCheckinMailDraft({report,snapshot}).text,current:result.details.current,archived:result.details.archived});
  }catch(e){if(current())setError(e instanceof Error?e.message:'读取失败，未改变报告或外发设置');}finally{window.clearTimeout(timer);if(current())setLoading(false);}})();return()=>{active=false;controller.abort();window.clearTimeout(timer);};
 },[ownerId,token,reportId,reload]);
 if(getCookie('token')!==token)return null;
 return <section className="life-report-explanation report-checkin-preview"><h3>固定生活复盘内容</h3>{loading?<p role="status">正在读取已保存快照…</p>:error?<p role="alert">{error}</p>:view?<>
  <p>{view.archived?'这是恢复的只读归档，不参与自动分析或发信。':view.current?'以下内容已随报告固定保存；预览不代表已发送，请以邮件状态为准。':'来源记录已更正、补记或撤回；此处保留原快照回看，不能据此重新外发旧内容。'}</p>
  <details><summary>展开事实版内容（不含日记）</summary><pre>{view.text}</pre></details>
 </>:<p>这份报告没有生活复盘扩展，不会从今天的记录补入过去的报告。</p>}
 <div className="report-checkin-actions"><button type="button" disabled={loading} onClick={()=>setReload(n=>n+1)}>重新读取快照</button><Link href="/life/check-in">记录或更正一天 →</Link></div></section>;
}
