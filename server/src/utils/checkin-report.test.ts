import {expect,it} from 'vitest';
import {checkinMailDraft,frozenCheckinMailDraft} from './checkin-report';
import {archiveReportCheckins,checkinAIShareableInMail,reportRangeFrom,type ReportCheckins} from './report-checkin-format';
import {emptyCheckin} from './checkin-format';
import {reportWindow,type LifeReportPreview} from './life-report';
function report():LifeReportPreview{return {version:1,ownerId:1,coverage:'server-synced-only',mode:'statistics-preview',aiEnabled:false,emailEnabled:false,generatedAt:'2026-11-02T00:00:00.000Z',period:reportWindow('daily',new Date('2026-11-02T00:00:00Z')),achievementsRecorded:2,tasksCompleted:1,ideasCreated:0,focus:{recordedMinutes:25,completedSessions:1,earlySessions:0},habitCompletions:1,daysWithNotes:1};}
it('renders fixed factual sections, selected records only, no journal field and no invented sleep/nutrition',()=>{
  const record=emptyCheckin();record.state='confirmed';record.items=[{key:crypto.randomUUID(),kind:'habit',source:null,name:'chosen fixture',result:'unrecorded',note:'',email:true,ai:false},{key:crypto.randomUUID(),kind:'checkin',source:null,name:'private fixture',result:'done',note:'',email:false,ai:true}];record.meals=[{key:crypto.randomUUID(),kind:'plan',description:'planned fixture',portion:'',email:true,ai:false}];record.sleep={bedAt:'2026-11-02T00:30:00+08:00',wakeAt:null,email:true,ai:false};
  const mail=checkinMailDraft({report:report(),entries:[{date:'2026-11-01',record}]});expect(mail.text).toContain('chosen fixture：未记录');expect(mail.text).not.toContain('private fixture');expect(mail.text).toContain('计划食谱：planned fixture；不计入摄入');expect(mail.text).toContain('起床 未记录');expect(mail.text).toContain('不生成营养数值');expect(mail.text).not.toContain('日历便签');
  record.state='draft';expect(checkinMailDraft({report:report(),entries:[{date:'2026-11-01',record}]}).text).not.toContain('chosen fixture');
});
it('rejects duplicate/out-of-period/free-text records before composing content',()=>{
  const row={date:'2026-11-01',record:emptyCheckin()};expect(()=>checkinMailDraft({report:report(),entries:[row,row]})).toThrow();expect(()=>checkinMailDraft({report:report(),entries:[{...row,date:'2026-11-02'}]})).toThrow();expect(()=>checkinMailDraft({report:report(),entries:[{...row,record:{...row.record,diary:'forbidden'} as any}]})).toThrow();
});
function frozen(r=report()):ReportCheckins{return {version:1,scopeVersion:2,generatedAt:r.generatedAt,fromDate:r.period.fromDate,toDateExclusive:r.period.toDateExclusive,rangeFrom:reportRangeFrom(r),sources:[],entries:[],current:{asOf:r.generatedAt,pendingTasks:2,todos:[]},reading:{markedRead:3,starred:1}};}
it('renders frozen seven-day observations across midnight and separates plans, missing data and AI-only content',()=>{
 const r=report(),s=frozen(r);
 for(const [date,bed] of [['2026-10-30','23:50'],['2026-10-31','00:10'],['2026-11-01','00:20']]){
  const record=emptyCheckin();record.state='confirmed';record.sleep={bedAt:date+'T'+bed+':00+08:00',wakeAt:null,email:true,ai:true};record.items=[{key:crypto.randomUUID(),kind:'habit',source:null,name:'selected habit',result:'unrecorded',note:'',email:true,ai:true}];
  if(date==='2026-11-01')record.items.push({key:crypto.randomUUID(),kind:'checkin',source:null,name:'AI ONLY PRIVATE',result:'done',note:'PRIVATE NOTE',email:false,ai:true});
  s.entries.push({date,revision:1,updatedAt:Date.parse(date+'T12:00:00+08:00')/1000,record});s.sources.push({date,revision:1,hmac:'a'.repeat(43)+'='});
 }
 const text=frozenCheckinMailDraft({report:r,snapshot:s}).text;expect(text).toContain('最短覆盖区间约 30 分钟');expect(text).toContain('3 条未记录');expect(text).toContain('标记已读 3 篇、收藏 1 篇');expect(text).toContain('综合分析不得直接放入邮件');expect(text).not.toContain('AI ONLY PRIVATE');expect(text).not.toContain('PRIVATE NOTE');expect(checkinAIShareableInMail(s)).toBe(false);
 const archived=archiveReportCheckins(s,r);expect(frozenCheckinMailDraft({report:r,snapshot:archived}).text).toBe(text);s.entries[2].record.items[1].email=true;expect(checkinAIShareableInMail(s)).toBe(true);
});
it('includes only frozen approved task labels and validates the weekly appendix without summing daily facts twice',()=>{
 const daily=report(),weekly={...daily,period:reportWindow('weekly',new Date(daily.generatedAt))},s=frozen(weekly),record=emptyCheckin();record.state='confirmed';record.items=[{key:crypto.randomUUID(),kind:'checkin',source:{kind:'todo',id:7},name:'frozen chosen label',result:'missed',note:'',email:true,ai:false}];s.entries=[{date:'2026-11-01',revision:1,updatedAt:Date.parse('2026-11-01T12:00:00+08:00')/1000,record}];s.sources=[{date:'2026-11-01',revision:1,hmac:'a'.repeat(43)+'='}];s.current.todos=[{id:7,name:'frozen chosen label',deadlineAt:Date.parse(weekly.generatedAt)/1000+3601}];
 const mail=frozenCheckinMailDraft({report:weekly,snapshot:s,daily});expect(mail.text).toContain('frozen chosen label：距期限约 2 小时');expect(mail.text).toContain('昨日日报附录（包含在上周范围，不重复相加）');expect(mail.text).toContain('成果 2 项，其中完成待办 1 项');expect(()=>frozenCheckinMailDraft({report:daily,snapshot:frozen(daily),daily})).toThrow('appendix');expect(()=>frozenCheckinMailDraft({report:weekly,snapshot:{...s,current:{...s.current,todos:[{...s.current.todos[0],name:'unapproved mutable title'}]}}})).toThrow();
});
