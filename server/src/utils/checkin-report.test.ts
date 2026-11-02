import {expect,it} from 'vitest';
import {checkinMailDraft} from './checkin-report';
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
