import {describe,expect,it} from 'vitest';
import {reportWindow,summarizeLifeReport,type ReportInput} from './life-report';

describe('Shanghai complete report periods',()=>{
  it('uses Shanghai midnight, including leap-day and year rollover',()=>{
    expect(reportWindow('daily',new Date('2024-03-01T00:00:00Z'))).toMatchObject({fromDate:'2024-02-29',toDateExclusive:'2024-03-01',start:'2024-02-28T16:00:00.000Z',end:'2024-02-29T16:00:00.000Z'});
    expect(reportWindow('daily',new Date('2026-12-31T16:00:00Z')).fromDate).toBe('2026-12-31');
    expect(reportWindow('daily',new Date('2026-12-31T15:59:59Z')).fromDate).toBe('2026-12-30');
  });
  it('takes the previous complete Monday-to-Monday week, including Sunday and Monday',()=>{
    expect(reportWindow('weekly',new Date('2026-11-01T00:00:00Z'))).toMatchObject({fromDate:'2026-10-19',toDateExclusive:'2026-10-26'});
    expect(reportWindow('weekly',new Date('2026-11-02T00:00:00Z'))).toMatchObject({fromDate:'2026-10-26',toDateExclusive:'2026-11-02',start:'2026-10-25T16:00:00.000Z',end:'2026-11-01T16:00:00.000Z'});
    expect(()=>reportWindow('daily',new Date('invalid'))).toThrow();
  });
});

describe('report facts stay owner-scoped and do not invent history',()=>{
  const period=reportWindow('daily',new Date('2026-11-02T00:00:00Z'));
  const todo={ownerId:1,type:'task',completed:1,createdAt:period.start,completedAt:period.start,deadlineAt:null};
  it('counts half-open boundaries and overlapping achievements once, never daily checklist completion',()=>{
    const input:ReportInput={
      todos:[todo,{...todo,type:'success'},{...todo,type:'daily'},{...todo,ownerId:2},{...todo,completedAt:period.end},{...todo,completed:0},{...todo,type:'learn',completed:0}],
      sessions:[{ownerId:1,endedAt:period.start,completed:1,completedEarly:1,focusMinutes:7},{ownerId:2,endedAt:period.start,completed:1,focusMinutes:25},{ownerId:1,endedAt:period.end,completed:1,focusMinutes:25}],
      habitLogs:[{ownerId:1,date:'2026-11-01',completed:1},{ownerId:2,date:'2026-11-01',completed:1},{ownerId:1,date:'2026-11-02',completed:1}],
      notes:[{ownerId:1,date:'2026-11-01',content:'private fixture'},{ownerId:2,date:'2026-11-01',content:'other account'}],
    };
    const before=JSON.stringify(input),result=summarizeLifeReport(1,period,input);
    expect(result).toMatchObject({achievementsRecorded:2,tasksCompleted:1,ideasCreated:1,focus:{completedSessions:1,recordedMinutes:7,earlySessions:1},habitCompletions:1,daysWithNotes:1,coverage:'server-synced-only'});
    expect(JSON.stringify(result)).not.toContain('private fixture');
    expect(JSON.stringify(result)).not.toContain('other account');
    expect(JSON.stringify(input)).toBe(before);
    expect(result).not.toHaveProperty('completionRate');
  });
  it('handles empty data and refuses missing owners or unbounded intervals',()=>{
    const empty:ReportInput={todos:[],sessions:[],habitLogs:[],notes:[]};
    expect(summarizeLifeReport(1,period,empty)).toMatchObject({achievementsRecorded:0,habitCompletions:0,daysWithNotes:0,focus:{recordedMinutes:0}});
    expect(()=>summarizeLifeReport(0,period,empty)).toThrow();
    expect(()=>summarizeLifeReport(1,{...period,end:'2027-01-01T00:00:00Z'},empty)).toThrow();
  });
});
