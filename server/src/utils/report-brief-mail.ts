import {briefFactsValue,type BriefFacts,type BriefContext,type BriefReview,type BriefList} from './report-brief-data';
import {rssDigestValue,type RssDigest} from './report-rss-digest';
import {reportMailMessage} from './report-mail-delivery';
import {reportSnapshot,type LifeReportPreview} from './life-report';
import {reportCheckinsValue,reportCheckinArchiveValue,type ReportCheckins,type ReportCheckinArchive} from './report-checkin-format';
import {rssStatusValue,type RssCaptureStatus} from './rss-daily-cycle';
import {checkinAIInput,checkinAIAnalysis,type CheckinAIAnalysis} from './checkin-ai-format';
import {checkinAIShareableInMail} from './report-checkin-format';

const ROOT='https://shjdness.github.io';
const text=(s:string,max:number)=>{const clean=s.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu,' ').replace(/\s+/g,' ').trim();return clean.length>max?clean.slice(0,max-1)+'…':clean;};
const date=(s:string)=>`${s}（周${['日','一','二','三','四','五','六'][new Date(s+'T12:00:00Z').getUTCDay()]}）`;
const clock=(s:string)=>new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
function duration(seconds:number){const minutes=Math.ceil(seconds/60),days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),rest=minutes%60;return [days?days+'天':'',hours?hours+'小时':'',rest?rest+'分钟':''].filter(Boolean).join('')||'不足1分钟';}
export function briefCountdown(deadlineAt:string|null,scheduledFor:string){
 if(deadlineAt===null)return '未启动倒计时';
 const delta=(Date.parse(deadlineAt)-Date.parse(scheduledFor))/1000;if(!Number.isFinite(delta))throw Error('Invalid brief deadline');
 return delta===0?'已到期':delta<0?'已超时 '+duration(-delta):'剩余 '+duration(delta);
}
function listLines<T>(list:BriefList<T>,limit:number,render:(value:T)=>string,empty:string){
 const shown=list.items.slice(0,limit),lines=shown.map(render);
 if(!list.total)lines.push(empty);
 if(list.total>shown.length)lines.push(`另 ${list.total-shown.length} 项，请在站内查看；总计 ${list.total} 项。`);
 return lines;
}
type Input={context:BriefContext;facts:BriefFacts;report:LifeReportPreview;rss?:RssDigest;rssRefresh?:RssCaptureStatus;checkins?:ReportCheckins|ReportCheckinArchive;analysis?:CheckinAIAnalysis};

/** New fixed-template preview/sender renderer. No live source lookup or AI call.
 * Private names are only mail facts. This pure function supplies no send consent:
 * the durable preparation/final claim must separately verify scope and sources. */
export function briefMailContent(input:Input){
 const facts=briefFactsValue(input.facts,input.context),report=reportSnapshot(input.context.owner,input.report);
 if(report.generatedAt!==facts.capturedAt||report.period.start!==input.context.period.start||report.period.end!==input.context.period.end||report.period.kind!==input.context.period.kind)throw Error('Brief report binding mismatch');
 const rss=input.rss?rssDigestValue(input.rss):null,refresh=input.rssRefresh?rssStatusValue(input.rssRefresh):null;
 if(rss&&Date.parse(rss.toExclusive)>Date.parse(facts.capturedAt))throw Error('RSS discovery extends beyond capture');
 const selected=input.checkins?('sources'in input.checkins?reportCheckinsValue(input.checkins,report):reportCheckinArchiveValue(input.checkins,report)):null;
 if(input.analysis&&(!selected||!checkinAIShareableInMail(selected)))throw Error('AI result is not shareable in mail');
 const analysis=input.analysis&&selected?checkinAIAnalysis(input.analysis,checkinAIInput(report,selected)):null;
 const weekly=report.period.kind==='weekly',subject=`夏令时电波 · ${weekly?'生活周报':'生活日报'} · ${facts.today.date}`;
 const build=(limit:number,labelMax:number)=>{
  const lines=[`${weekly?'本周安排':'今日日报'} ${date(facts.today.date)}`,`数据采集：${clock(facts.capturedAt)}（北京时间）`,'', '一、今日三件事',
   ...listLines(facts.today.priorities,3,p=>`- ${p.completed?'✓':'□'} ${text(p.name,labelMax)}`,'- 今天尚未安排三件事。'),
   '',`二、待办清单（倒计时以 ${clock(facts.scheduledFor)} 为准）`,
   ...listLines(facts.today.pending,limit,p=>`- ${text(p.name,labelMax)}｜${briefCountdown(p.deadlineAt,facts.scheduledFor)}`,'- 暂无未完成待办。'),
   '',weekly?'三、RSS 阅读更新汇总':'三、今日 RSS 阅读更新'];
  if(!rss)lines.push('本次未取得可核对的 RSS 新收录明细；请在站内查看，不代表没有更新。');
  else{
   lines.push(`首次入库窗口：${clock(rss.from)} 至 ${clock(rss.toExclusive)} 前；不是今日发布数量。`);
   for(const [title,part] of [['订阅更新',rss.updates],['历史补录',rss.history],['来源未分类',rss.unclassified]] as const){
    lines.push(`${title}：${part.items} 条，${part.channels} 个频道`);
    const categories=part.categories.slice(0,limit),sample=Math.min(3,limit);
    for(const c of categories){const chosen=c.listed.slice(0,sample);lines.push(`- ${text(c.name,50)}｜${c.items} 条｜${chosen.map(s=>`${text(s.name,labelMax)}（${s.items}）`).join('、')}${c.channels>chosen.length?`；另 ${c.channels-chosen.length} 个频道`:''}`);}
    const omitted=part.omittedCategories+part.categories.length-categories.length;if(omitted)lines.push(`另 ${omitted} 个分类，完整明细见站内 RSS。`);
   }
  }
  if(refresh&&refresh.state!=='complete')lines.push(refresh.state==='partial'?'本轮部分刷新步骤未成功，保留已获取内容和最近可用数据。':'本轮刷新未在采集截止前确认完成，使用已有数据。');
  lines.push(`查看频道：${ROOT}/life/rss`);
  const review=(r:BriefReview,title:string,detailLimit:number)=>{
   lines.push('',title,'一、完成待办',...listLines(r.tasks,detailLimit,t=>`- ✓ ${text(t.name,labelMax)}｜${clock(t.completedAt)}`,'- 没有已同步的完成记录。'));
   if(r.successes.total)lines.push('成功记录与完成构想',...listLines(r.successes,detailLimit,t=>`- ${text(t.name,labelMax)}`,''));
   lines.push('','二、习惯打卡',...listLines(r.habits,detailLimit,h=>`- ✓ ${text(h.name,labelMax)}${weekly?'｜'+h.date:''}`,'- 没有已同步的习惯完成记录。'));
   if(r.unrecordedHabits?.total)lines.push(`未见打卡：${r.unrecordedHabits.items.slice(0,detailLimit).map(n=>text(n,labelMax)).join('、')}${r.unrecordedHabits.total>detailLimit?'等':''}。未记录不等于未完成。`);
   lines.push('','三、完成专注',...listLines(r.focus,detailLimit,f=>`- ${text(f.name,labelMax)}｜${clock(f.startedAt)} 开始｜${f.minutes} 分钟`,'- 没有已同步的完整专注记录。'),`合计：${r.focus.total} 次，${r.focusMinutes} 分钟（保存值，按结束日期归属）。`);
   const entries=selected?.entries.filter(e=>e.date>=r.fromDate&&e.date<r.toDateExclusive)??[];
   const checkins=entries.flatMap(e=>e.record.items.filter(i=>i.email).map(i=>({date:e.date,item:i}))),meals=entries.flatMap(e=>e.record.meals.filter(m=>m.email).map(m=>({date:e.date,meal:m}))),sleep=entries.filter(e=>e.record.sleep.email&&(e.record.sleep.bedAt||e.record.sleep.wakeAt));
   if(checkins.length){const labels={done:'完成',missed:'明确未完成',unrecorded:'未记录',na:'不适用'};lines.push('','四、生活复盘中的自选打卡（不与上方习惯重复相加）',...checkins.slice(0,detailLimit).map(c=>`- ${weekly?c.date+'｜':''}${text(c.item.name,labelMax)}：${labels[c.item.result]}`));if(checkins.length>detailLimit)lines.push(`另 ${checkins.length-detailLimit} 项，见完整报告。`);}
   if(meals.length||sleep.length){
    lines.push('','五、饮食与作息');
    for(const m of meals.slice(0,detailLimit))lines.push(`- ${weekly?m.date+'｜':''}${m.meal.kind==='plan'?'计划食谱（非摄入）':'已食用'}：${text(m.meal.description,labelMax)}${m.meal.portion?'；份量 '+text(m.meal.portion,40):'；份量未记录'}`);
    if(meals.length>detailLimit)lines.push(`另 ${meals.length-detailLimit} 条饮食记录，见完整报告。`);
    const recordedClock=(s:string|null)=>s?clock(s)+(Date.parse(s)>Date.parse(facts.capturedAt)?'（预填，采集时尚未发生）':''):'未记录';
    for(const s of sleep.slice(-Math.min(2,detailLimit)))lines.push(`- ${s.date}｜上床 ${recordedClock(s.record.sleep.bedAt)}；起床 ${recordedClock(s.record.sleep.wakeAt)}`);
    lines.push('上床与起床间隔不等于实际睡眠时长；缺失不补零，不推算营养数值。');
   }
  };
  review(facts.review,weekly?`上周复盘 ${facts.review.fromDate} 至 ${facts.review.toDateExclusive} 前`:`昨日复盘 ${date(facts.review.fromDate)}`,limit);
  if(facts.yesterday){const overlaps=facts.yesterday.fromDate>=facts.review.fromDate&&facts.yesterday.toDateExclusive<=facts.review.toDateExclusive;review(facts.yesterday,`昨日日报附录 ${date(facts.yesterday.fromDate)}（${overlaps?'包含在上周统计中，不重复相加':'与上周分别展示，不相加'}）`,Math.min(3,limit));}
  const aiLines=analysis?[text(analysis.summary,limit>2?160:100),...(['habits','checkins','diet','routine'] as const).map(module=>{
   const part=analysis.modules[module],label={habits:'习惯',checkins:'打卡',diet:'饮食',routine:'作息'}[module];
   return `- ${label}：${part.status==='insufficient'?'记录不足，暂不判断。':part.observations[0]?text(part.observations[0].text,limit>2?120:80):'暂无足够观察。'}${part.actions[0]?' 可选一步：'+text(part.actions[0],limit>2?100:60):''}`;
  }),'AI 建议仅基于选定记录，可能不准确；不是医学或营养诊断，不替代本人判断。']:['本次未附可用于邮件的 AI 分析，以上事实不受影响。'];
  lines.push('','AI 复盘与建议',...aiLines,
   '',`明日预告 ${date(facts.tomorrow.date)}`,...listLines(facts.tomorrow.priorities,3,p=>`- ${text(p.name,labelMax)}`,'- 明日尚未安排三件事。'),
   '', '只含已同步数据；采集后的补记不会改写本封快照。旧完成事项缺少实际完成时间时不推算归属。每日执行是记忆清单，不计习惯打卡率。',
   `完整报告／暂停提醒：${ROOT}/life/reports`, `安排事项：${ROOT}/life/todos`, `记录习惯：${ROOT}/life/habits`);
  return lines.join('\n');
 };
 // Bound text before SMTP's base64 encoding; normal/fallback rendering preserves
 // every section and exact counts, with explicit omissions and site links.
 let content='';for(const [limit,max] of [[8,80],[4,60],[2,40]]){content=build(limit,max);if(new TextEncoder().encode(content).length<=14000)break;}
 if(new TextEncoder().encode(content).length>14000)throw Error('Brief mail exceeds byte budget');
 const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
 // QQ/Brevo use plain text. HTML is a concise safe landing link; it does not
 // duplicate a large sensitive body and cannot carry source-supplied markup.
 return reportMailMessage({subject,text:content,html:`<h1>${escape(subject)}</h1><p>今日安排与上期复盘详见本邮件纯文本正文，或登录查看完整报告。</p><p><a href="${ROOT}/life/reports">查看报告及暂停提醒</a></p>`});
}
