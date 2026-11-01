import {reportSnapshot,reportWindow,type LifeReportPreview} from './life-report';
import {analysisValue,type ReportAnalysis} from './report-analysis-format';

const LINK='https://shjdness.github.io/life/reports';
const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));

/** Pure numeric summary renderer; no recipient/credentials/free-text source
 * fields. Links carry no token, email, owner ID or private report identifier. */
export function reportMailContent(input:{report:LifeReportPreview;daily?:LifeReportPreview;analysis?:ReportAnalysis}){
  const report=reportSnapshot(input.report.ownerId,input.report);
  const daily=input.daily?reportSnapshot(report.ownerId,input.daily):undefined;
  const yesterday=reportWindow('daily',new Date(report.generatedAt));
  if(daily&&(report.period.kind!=='weekly'||daily.period.kind!=='daily'||daily.period.start!==yesterday.start||daily.period.end!==yesterday.end))throw Error('Combined report period mismatch');
  const dailyOverlaps=Boolean(daily&&Date.parse(daily.period.start)>=Date.parse(report.period.start)&&Date.parse(daily.period.end)<=Date.parse(report.period.end));
  const analysis=input.analysis?analysisValue(input.analysis):undefined;
  const label=report.period.kind==='weekly'?'生活周报':'生活日报';
  const subject=`夏令时电波 · ${label} · ${report.period.fromDate}`;
  const block=(value:LifeReportPreview,title:string)=>[
    title,`周期：${value.period.fromDate} 起，至 ${value.period.toDateExclusive} 前（北京时间）`,
    `已记录成果：${value.achievementsRecorded}；其中完成待办：${value.tasksCompleted}（不重复相加）`,
    `专注：${value.focus.recordedMinutes} 分钟，${value.focus.completedSessions} 轮；其中提前结束 ${value.focus.earlySessions} 轮`,
    `习惯完成记录：${value.habitCompletions} 次；有日历便签：${value.daysWithNotes} 天`,
    `新增未来构想：${value.ideasCreated}`,
  ];
  const lines=[...block(report,label),...(daily?['',...block(daily,dailyOverlaps?'昨日记录（包含在上周统计中，不重复相加）':'昨日记录（与上周统计分别展示）')]:[]),
    ...(analysis?['','AI 数字复盘（可能有误，仅供参考）',analysis.summary,...analysis.observations.map(s=>`观察：${s}`),...analysis.actions.map(s=>`可选行动：${s}`)]:['','本次为统计版。']),
    '', '只包含已同步记录，不代表完整生活；无记录不等于没有行动。每日执行是记忆清单，不计习惯打卡率。',
    '专注分钟为保存值，不是独立核验用时。', '', `查看报告及暂停提醒：${LINK}（需登录）`];
  const text=lines.join('\n');
  const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><h1>'+escape(subject)+'</h1>'+lines.slice(0,-1).map(line=>line?'<p>'+escape(line)+'</p>':'<br>').join('')+`<p><a href="${LINK}">查看报告及暂停提醒（需登录）</a></p></body></html>`;
  return {subject,text,html};
}
