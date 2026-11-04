import {expect,it} from 'vitest';
import {briefMailContent,briefCountdown} from './report-brief-mail';
import {reportWindow,type LifeReportPreview} from './life-report';
import type {BriefContext,BriefFacts,BriefReview} from './report-brief-data';
import type {RssDigest} from './report-rss-digest';
import {emptyCheckin} from './checkin-format';
import {reportRangeFrom,type ReportCheckins} from './report-checkin-format';
const context=(kind:'daily'|'weekly'='daily'):BriefContext=>({owner:1,period:reportWindow(kind,new Date('2026-11-03T00:00:00Z')),capturedAt:new Date('2026-11-02T21:00:00Z'),scheduledFor:new Date('2026-11-03T00:00:00Z')});
function fixture(kind:'daily'|'weekly'='daily'){
 const c=context(kind),part=(period:ReturnType<typeof reportWindow>):BriefReview=>({fromDate:period.fromDate,toDateExclusive:period.toDateExclusive,tasks:{total:0,items:[]},successes:{total:0,items:[]},habits:{total:0,items:[]},focus:{total:0,items:[]},focusMinutes:0,unrecordedHabits:period.kind==='daily'?{total:0,items:[]}:null});
 const facts:BriefFacts={version:1,capturedAt:c.capturedAt.toISOString(),scheduledFor:c.scheduledFor.toISOString(),today:{date:'2026-11-03',priorities:{total:1,items:[{name:'今日三件事之一',completed:false}]},pending:{total:3,items:[{name:'任务A',deadlineAt:'2026-11-03T01:00:00.000Z'},{name:'任务B',deadlineAt:'2026-11-02T23:30:00.000Z'},{name:'未启动任务',deadlineAt:null}]}},tomorrow:{date:'2026-11-04',priorities:{total:1,items:[{name:'明日事项',completed:false}]}},review:part(c.period),yesterday:kind==='weekly'?part(reportWindow('daily',c.scheduledFor)):null};
 const report:LifeReportPreview={version:1,ownerId:1,generatedAt:facts.capturedAt,period:c.period,coverage:'server-synced-only',mode:'statistics-preview',achievementsRecorded:0,tasksCompleted:0,ideasCreated:0,focus:{completedSessions:0,recordedMinutes:0,earlySessions:0},habitCompletions:0,daysWithNotes:0,aiEnabled:false,emailEnabled:false};
 const empty=()=>({items:0,channels:0,categories:[],omittedCategories:0,omittedCategoryItems:0});
 const rss:RssDigest={version:1,from:'2026-11-01T21:00:00.000Z',toExclusive:facts.capturedAt,updates:{items:2,channels:1,categories:[{name:'音乐',items:2,channels:1,listed:[{name:'频道A',items:2}],omittedChannels:0}],omittedCategories:0,omittedCategoryItems:0},history:empty(),unclassified:empty()};
 return {context:c,facts,report,rss};
}
it('renders today and yesterday with actual names, planned-day headings and 08:00 countdown instead of capture-time countdown',()=>{
 const f=fixture();f.facts.review.tasks={total:1,items:[{name:'昨日完成任务',completedAt:'2026-11-02T10:00:00.000Z'}]};f.facts.review.habits={total:1,items:[{name:'练琴',date:'2026-11-02'}]};f.facts.review.focus={total:1,items:[{name:'学习任务',startedAt:'2026-11-02T01:00:00.000Z',endedAt:'2026-11-02T01:25:00.000Z',minutes:25}]};f.facts.review.focusMinutes=25;
 const mail=briefMailContent(f);expect(mail.subject).toBe('夏令时电波 · 生活日报 · 2026-11-03');
 for(const text of ['今日日报 2026-11-03（周二）','昨日复盘 2026-11-02（周一）','今日三件事之一','任务A｜剩余 1小时','任务B｜已超时 30分钟','未启动任务｜未启动倒计时','音乐｜2 条｜频道A（2）','昨日完成任务','练琴','学习任务','25 分钟','明日事项'])expect(mail.text).toContain(text);
 expect(mail.text).not.toContain('示例分析');expect(mail.text).toContain('本次未附可用于邮件的 AI 分析');expect(mail.html).not.toContain('昨日完成任务');
});
it('keeps zero/no-record descriptions honest and distinguishes unavailable refresh from no updates',()=>{
 const f=fixture(),mail=briefMailContent({...f,rss:undefined,rssRefresh:{day:'2026-11-03',state:'missing',expected:null,succeeded:null,finishedAt:null,wait:false}});
 expect(mail.text).toContain('未取得可核对的 RSS 新收录明细');expect(mail.text).toContain('没有已同步的完成记录');expect(mail.text).toContain('本轮刷新未在采集截止前确认完成');expect(mail.text).not.toContain('订阅更新：0');expect(mail.text).not.toContain('睡眠时长：0');
});
it('keeps weekly review and yesterday appendix separate without duplicating totals',()=>{
 const f=fixture('weekly'),mail=briefMailContent(f);expect(mail.subject).toContain('生活周报');expect(mail.text).toContain('上周复盘 2026-10-26 至 2026-11-02 前');expect(mail.text).toContain('昨日日报附录 2026-11-02（周一）（与上周分别展示，不相加）');
});
it('rejects hidden free text and snapshot/owner mismatches instead of silently serializing it',()=>{
 const f=fixture();expect(()=>briefMailContent({...f,facts:{...f.facts,diary:'secret'} as any})).toThrow();expect(()=>briefMailContent({...f,report:{...f.report,ownerId:2}})).toThrow();expect(()=>briefMailContent({...f,report:{...f.report,generatedAt:'2026-11-02T22:00:00.000Z'}})).toThrow();
});
it('keeps a fully populated weekly mail below the QQ pre-encoding byte budget with explicit omissions',()=>{
 const f=fixture('weekly'),name='很长的合成名称'.repeat(50);
 const fill=(r:BriefReview)=>{r.tasks={total:500,items:Array.from({length:20},()=>({name:name.slice(0,100),completedAt:r.fromDate+'T10:00:00.000Z'}))};r.habits={total:100,items:Array.from({length:30},()=>({name:name.slice(0,100),date:r.fromDate}))};r.focus={total:100,items:Array.from({length:20},()=>({name:name.slice(0,100),startedAt:r.fromDate+'T01:00:00.000Z',endedAt:r.fromDate+'T01:25:00.000Z',minutes:25}))};r.focusMinutes=2500;};
 fill(f.facts.review);fill(f.facts.yesterday!);const mail=briefMailContent(f);expect(new TextEncoder().encode(mail.text).length).toBeLessThanOrEqual(14000);expect(mail.text).toContain('另 ');expect(mail.text).toContain('总计 500 项');expect(mail.text).toContain('三、完成专注');expect(mail.text).toContain('明日预告');
});
it('handles exact expiry and duration boundaries deterministically',()=>{
 const at='2026-11-03T00:00:00.000Z';expect(briefCountdown(at,at)).toBe('已到期');expect(briefCountdown('2026-11-05T06:00:00.000Z',at)).toBe('剩余 2天6小时');
});
it('includes only email-selected meals/checkins and flags prefilled future routine times',()=>{
 const f=fixture(),record=emptyCheckin();record.state='confirmed';
 record.items=[{key:crypto.randomUUID(),kind:'checkin',source:null,name:'邮件可见打卡',result:'done',note:'',email:true,ai:false},{key:crypto.randomUUID(),kind:'habit',source:null,name:'仅AI可见习惯',result:'done',note:'私密备注',email:false,ai:true}];
 record.meals=[{key:crypto.randomUUID(),kind:'plan',description:'计划吃面条',portion:'一碗',email:true,ai:false},{key:crypto.randomUUID(),kind:'eaten',description:'仅AI可见饮食',portion:'',email:false,ai:true}];
 record.sleep={bedAt:'2026-11-02T23:00:00+08:00',wakeAt:'2026-11-03T07:00:00+08:00',email:true,ai:false};
 const snapshot:ReportCheckins={version:1,scopeVersion:2,generatedAt:f.report.generatedAt,fromDate:f.report.period.fromDate,toDateExclusive:f.report.period.toDateExclusive,rangeFrom:reportRangeFrom(f.report),sources:[{date:'2026-11-02',revision:1,hmac:'a'.repeat(43)+'='}],entries:[{date:'2026-11-02',revision:1,updatedAt:Date.parse('2026-11-02T12:00:00+08:00')/1000,record}],current:{asOf:f.report.generatedAt,pendingTasks:0,todos:[]},reading:{markedRead:0,starred:0}};
 const mail=briefMailContent({...f,checkins:snapshot});expect(mail.text).toContain('邮件可见打卡');expect(mail.text).toContain('计划食谱（非摄入）：计划吃面条');expect(mail.text).toContain('预填，采集时尚未发生');expect(mail.text).not.toContain('仅AI可见');expect(mail.text).not.toContain('私密备注');expect(mail.text).not.toContain('睡眠时长：8');
});
