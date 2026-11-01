import {expect,it} from 'vitest';
import {dueReportOccurrence} from './report-schedule';
import {reportMailContent} from './report-mail-format';
import {reportWindow,type LifeReportPreview} from './life-report';
const prefs={ownerId:1,dailyEnabled:true,weeklyEnabled:true,dailyTime:'08:00',weeklyTime:'08:00',weeklyDay:1};
const sample=(kind:'daily'|'weekly',now=new Date('2026-11-02T00:00:00Z')):LifeReportPreview=>({version:1,ownerId:1,generatedAt:now.toISOString(),period:reportWindow(kind,now),coverage:'server-synced-only',mode:'statistics-preview',achievementsRecorded:2,tasksCompleted:1,ideasCreated:0,focus:{completedSessions:1,recordedMinutes:7,earlySessions:1},habitCompletions:1,daysWithNotes:1,aiEnabled:false,emailEnabled:false});

it('plans Shanghai daily/weekly complete periods and merges Monday daily into one occurrence',()=>{
  expect(dueReportOccurrence(prefs,new Date('2026-11-01T23:59:59Z'))).toBeNull();
  const monday=dueReportOccurrence(prefs,new Date('2026-11-02T00:00:00Z'))!;
  expect(monday).toMatchObject({kind:'weekly',includeDaily:true,scheduledAt:'2026-11-02T00:00:00.000Z',period:{fromDate:'2026-10-26',toDateExclusive:'2026-11-02'}});
  const later=dueReportOccurrence({...prefs,weeklyTime:'09:00'},new Date('2026-11-02T12:00:00Z'))!;
  expect(later.occurrenceKey).toBe(monday.occurrenceKey);
  expect(dueReportOccurrence({...prefs,weeklyTime:'09:00'},new Date('2026-11-02T00:30:00Z'))).toBeNull();
  expect(dueReportOccurrence(prefs,new Date('2026-11-03T00:00:00Z'))).toMatchObject({kind:'daily',includeDaily:false,period:{fromDate:'2026-11-02',toDateExclusive:'2026-11-03'}});
  expect(dueReportOccurrence({...prefs,dailyEnabled:false,weeklyEnabled:false},new Date('2026-11-02T00:00:00Z'))).toBeNull();
});

it('handles midnight/year boundaries and explicit disabled weekly reminders without inventing missed occurrences',()=>{
  const due=dueReportOccurrence({...prefs,weeklyEnabled:false,dailyTime:'00:00'},new Date('2026-12-31T16:00:00Z'))!;
  expect(due).toMatchObject({kind:'daily',period:{fromDate:'2026-12-31',toDateExclusive:'2027-01-01'},scheduledAt:'2026-12-31T16:00:00.000Z'});
  expect(()=>dueReportOccurrence({...prefs,dailyTime:'29:00'})).toThrow();
  expect(()=>dueReportOccurrence({...prefs,dailyEnabled:'false'} as any)).toThrow();
});

it('renders numeric-only mail with login-only links and clear weekly/daily overlap semantics',()=>{
  const input={report:{...sample('weekly'),privateName:'secret fixture'},daily:{...sample('daily'),diaryBody:'private fixture'},analysis:{summary:'记录很少 & 仍然值得保留。',observations:['继续用“小步”记录。'],actions:[]}};
  const mail=reportMailContent(input);
  expect(mail.subject).toContain('生活周报');
  const wednesday=new Date('2026-11-04T00:00:00Z');expect(reportMailContent({report:sample('weekly',wednesday),daily:sample('daily',wednesday)}).text).toContain('与上周统计分别展示');expect(mail.text).toContain('包含在上周统计中，不重复相加');
  expect(mail.html).toContain('&amp;');expect(mail.html).not.toContain('private fixture');expect(mail.html).not.toContain('secret fixture');
  expect(mail.html).not.toMatch(/token=|ownerId|mailto:/);expect(mail.html).toContain('https://shjdness.github.io/life/reports');
  expect(()=>reportMailContent({...input,daily:{...input.daily,ownerId:2}})).toThrow();
  expect(()=>reportMailContent({...input,daily:sample('daily',new Date('2026-11-04T00:00:00Z'))})).toThrow('period');
  expect(()=>reportMailContent({...input,analysis:{...input.analysis,summary:'<script>fixture</script>'}})).toThrow();
});
