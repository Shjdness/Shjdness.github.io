import {checkinDate,checkinValue,type Checkin} from './checkin-format';
import {reportSnapshot,type LifeReportPreview} from './life-report';

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
