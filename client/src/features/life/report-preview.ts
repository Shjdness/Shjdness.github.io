import type {LifeReportPreview} from '../../../../server/src/utils/life-report';
export type {LifeReportPreview};

export async function loadReportPreview(options:{endpoint:string;token:string;ownerId:number;kind:'daily'|'weekly';signal:AbortSignal;currentToken:()=>string|undefined;fetcher?:(input:string,init?:RequestInit)=>Promise<Response>}){
  const {endpoint,token,ownerId,kind,signal,currentToken}=options;
  const current=()=>{if(signal.aborted)throw Error('请求已取消');if(currentToken()!==token)throw Error('账号已切换，请重新登录后查看');};
  current();
  const response=await (options.fetcher??fetch)(`${endpoint}/life/reports/preview?kind=${kind}`,{headers:{Authorization:`Bearer ${token}`},signal,cache:'no-store',credentials:'omit'});
  current();
  if(!response.ok)throw Error(response.status===403?'当前账号没有查看复盘的权限':response.status===503?'服务暂不可用，请稍后重试':response.status===429?'刷新过于频繁，请稍后重试':'暂时无法加载统计预览，请重试');
  const report:LifeReportPreview=await response.json();
  current();
  const counts=[report?.achievementsRecorded,report?.tasksCompleted,report?.ideasCreated,report?.habitCompletions,report?.daysWithNotes,report?.focus?.completedSessions,report?.focus?.recordedMinutes,report?.focus?.earlySessions];
  if(report?.ownerId!==ownerId||report.version!==1||report.period?.kind!==kind||report.period.timezone!=='Asia/Shanghai'||report.coverage!=='server-synced-only'||report.mode!=='statistics-preview'||counts.some(value=>!Number.isSafeInteger(value)||value<0)||!Number.isFinite(Date.parse(report.generatedAt))){
    throw Error('报告身份、格式或版本不匹配，请重试');
  }
  return report;
}
