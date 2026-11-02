import {checkinDate,checkinValue,type Checkin} from './checkin-format';
import {reportSnapshot,type LifeReportPreview} from './life-report';
import {reportCheckinsValue,reportCheckinArchiveValue,checkinAIShareableInMail,type ReportCheckins,type ReportCheckinArchive} from './report-checkin-format';

type Entry={date:string;record:Checkin};
const labels={done:'完成',missed:'明确未完成',unrecorded:'未记录',na:'不适用'};
const line=(s:string,max:number)=>s.replace(/\s+/g,' ').trim().slice(0,max);
/** Pure proposal renderer. Deliberately NOT wired to the sender until the
 * owner-scoped immutable extension snapshot and its backup are implemented.
 * Input must be an already frozen, at most seven-day selection, never diaries. */
export function checkinMailDraft(input:{report:LifeReportPreview;entries:Entry[]}){
  const report=reportSnapshot(input.report.ownerId,input.report),days=report.period.kind==='daily'?1:7;
  if(!Array.isArray(input.entries)||input.entries.length>days)throw Error('Check-in report period overflow');
  const seen=new Set<string>(),entries:Entry[]=[];
  for(const e of [...input.entries].sort((a,b)=>a.date.localeCompare(b.date))){const date=checkinDate(e.date);if(date<report.period.fromDate||date>=report.period.toDateExclusive||seen.has(date))throw Error('Check-in report date mismatch');seen.add(date);const record=checkinValue(e.record,date);if(record.state==='confirmed')entries.push({date,record});}
  const selected=entries.flatMap(e=>e.record.items.filter(i=>i.email).map(i=>({...i,date:e.date})));
  const meals=entries.flatMap(e=>e.record.meals.filter(m=>m.email).map(m=>({...m,date:e.date})));
  const sleeps=entries.filter(e=>e.record.sleep.email&&(e.record.sleep.bedAt||e.record.sleep.wakeAt));
  const habits=selected.filter(i=>i.kind==='habit'),done=selected.filter(i=>i.result==='done').length;
  const clock=(s:string|null)=>s?s.slice(0,10)+' '+s.slice(11,16):'未记录';
  const ticks=selected.slice(-5).map(i=>`• ${days===7?i.date+' ':''}${line(i.name,60)}：${labels[i.result]}${i.note?'；'+line(i.note,100):''}`);
  const eaten=meals.filter(m=>m.kind==='eaten'),plans=meals.filter(m=>m.kind==='plan');
  const dietary=[...eaten.slice(-3).map(m=>`• 已食用：${line(m.description,120)}${m.portion?'（'+line(m.portion,60)+'）':'（份量未记录）'}`),...plans.slice(-2).map(m=>`• 计划食谱：${line(m.description,100)}；不计入摄入`)];
  const sleep=sleeps.slice(-2).flatMap(e=>[`• ${e.date}：上床 ${clock(e.record.sleep.bedAt)}；起床 ${clock(e.record.sleep.wakeAt)}`]);
  const lines=[`夏令时电波 · ${days===7?'生活周报':'生活日报'} · ${report.period.fromDate}`,
    `周期：${report.period.fromDate} 起，至 ${report.period.toDateExclusive} 前（北京时间）`,'',
    days===7?'上周的进展':'昨天的进展',`已同步记录包含 ${report.achievementsRecorded} 项成果，其中 ${report.tasksCompleted} 项为完成待办，两者不重复相加。生活复盘已确认 ${entries.length}/${days} 天；选定打卡中有 ${done} 条完成记录。`,
    '', '打卡项目',...(ticks.length?ticks:['尚未选择可进邮件的打卡项目。未记录不等于未完成。']),
    '', '习惯观察',habits.length?`选定习惯：完成 ${habits.filter(i=>i.result==='done').length} 条，明确未完成 ${habits.filter(i=>i.result==='missed').length} 条，未记录 ${habits.filter(i=>i.result==='unrecorded').length} 条，不适用 ${habits.filter(i=>i.result==='na').length} 条。没有历史计划分母，不推算完成率。`:'尚无选定习惯记录，可在生活复盘中选择项目。',
    '', '专注与学习',`保存的专注 ${report.focus.recordedMinutes} 分钟、${report.focus.completedSessions} 轮，其中提前结束 ${report.focus.earlySessions} 轮；不等同独立测量用时。`,
    '', '食谱与饮食',...(dietary.length?dietary:['尚未选择可进邮件的饮食记录。']),`本周期选定已食用 ${eaten.length} 条、计划食谱 ${plans.length} 条。没有可靠份量或分析结果时不生成营养数值。`,
    '', '作息',...(sleep.length?sleep:['尚未选择可进邮件的作息记录。']),'上床与起床是本人记录，间隔不等于实际睡眠时长；缺失不补零。',
    '', '今天先做一小步','可从上面一项愿意继续的项目开始；需要时先拆成十分钟内可执行的一步。每日执行仍是记忆清单，不计算习惯打卡率。',
    '', '综合观察','本次为事实版；尚无已验证的四模块 AI 分析，不编造原因或健康结论。',
    '', `数据截至 ${new Date(report.generatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}。仅包含已同步、已确认且选进邮件的复盘；本机草稿和未选内容不在其中。`,
    '补记、更正： https://shjdness.github.io/life/check-in',
    '完整报告与暂停： https://shjdness.github.io/life/reports（需登录）'];
  const text=lines.join('\n');if(new TextEncoder().encode(text).length>14000)throw Error('Check-in mail exceeds byte budget');
  return {subject:`夏令时电波 · ${days===7?'生活周报':'生活日报'} · ${report.period.fromDate}`,text};
}
/** Deterministic frozen-content preview, also used by the future sender. No
 * mutable source lookup, no model output or extra permission inferred here. */
export function frozenCheckinMailDraft(input:{report:LifeReportPreview;snapshot:ReportCheckins|ReportCheckinArchive;daily?:LifeReportPreview}){
 const report=reportSnapshot(input.report.ownerId,input.report),s='sources' in input.snapshot?reportCheckinsValue(input.snapshot,report):reportCheckinArchiveValue(input.snapshot,report);
 const mail=checkinMailDraft({report,entries:s.entries.filter(e=>e.date>=s.fromDate).map(e=>({date:e.date,record:e.record}))});
 const chosen=s.entries.flatMap(e=>e.record.items.filter(i=>i.email&&i.kind==='habit'));
 const habits=`近七天选定习惯：${chosen.filter(i=>i.result==='done').length} 条完成、${chosen.filter(i=>i.result==='missed').length} 条明确未完成、${chosen.filter(i=>i.result==='unrecorded').length} 条未记录、${chosen.filter(i=>i.result==='na').length} 条不适用；不据此推算计划完成率。`;
 const beds=s.entries.filter(e=>e.record.sleep.email&&e.record.sleep.bedAt).map(e=>e.record.sleep.bedAt!).map(t=>Number(t.slice(11,13))*60+Number(t.slice(14,16))).sort((a,b)=>a-b);
 let routine='上床时刻记录不足三天，暂不判断规律。';if(beds.length>=3){const gaps=beds.map((n,i)=>i? n-beds[i-1]:n+1440-beds[beds.length-1]);routine=`近七天有 ${beds.length} 天上床时刻，按跨午夜钟表计算的最短覆盖区间约 ${1440-Math.max(...gaps)} 分钟；不据此诊断睡眠质量。`;}
 const pending=s.current.todos.map(t=>{const remaining=t.deadlineAt===null?null:t.deadlineAt-Math.floor(Date.parse(s.current.asOf)/1000);return `• ${line(t.name,80)}：${remaining===null?'未设置倒计时':remaining<=0?'72小时期限已到':`距期限约 ${Math.ceil(remaining/3600)} 小时`}`;});
 const late=s.entries.filter(e=>e.date<s.fromDate&&e.updatedAt*1000>=Date.parse(report.period.start)&&e.updatedAt*1000<Date.parse(report.period.end)&&(e.record.items.some(i=>i.email)||e.record.meals.some(m=>m.email)||e.record.sleep.email)).slice(-3).map(e=>e.date);
 const daily=input.daily?reportSnapshot(report.ownerId,input.daily):null;
 if(daily&&(report.period.kind!=='weekly'||daily.period.kind!=='daily'||daily.period.end!==report.period.end))throw Error('Invalid weekly appendix');
 const additions=['','七天记录观察',habits,routine,'','截至快照时值得留意的事',...(pending.length?pending:['没有选进邮件的当前待办标题。']),`当前共有 ${s.current.pendingTasks} 项未完成待办，其他事项请回到站内查看。`,
 '','阅读与灵感',`本周期标记已读 ${s.reading.markedRead} 篇、收藏 ${s.reading.starred} 篇；这是标记事件，不证明完整阅读，不读取标题或正文。`,
 ...(late.length?['','补记更新',`${late.join('、')} 的选定记录已补记或更正；仍归原日期，不重复计入当天成果。`]:[]),
 ...(!checkinAIShareableInMail(s)?['','AI内容范围','部分AI输入只允许站内分析；综合分析不得直接放入邮件。']:[]),
 ...(daily?['','昨日日报附录（包含在上周范围，不重复相加）',`已记录成果 ${daily.achievementsRecorded} 项，其中完成待办 ${daily.tasksCompleted} 项；专注 ${daily.focus.recordedMinutes} 分钟、${daily.focus.completedSessions} 轮。`]:[])];
 const at=mail.text.indexOf('\n数据截至 ');const text=(at<0?mail.text:mail.text.slice(0,at))+additions.join('\n')+(at<0?'':mail.text.slice(at));if(new TextEncoder().encode(text).length>14000)throw Error('Frozen mail exceeds byte budget');return {subject:mail.subject,text};
}
