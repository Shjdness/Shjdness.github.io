/** Deterministic report facts. Never call a provider or mutate source records. */
export type ReportKind = 'daily' | 'weekly';
const DAY = 86_400_000;
const SHANGHAI_OFFSET = 8 * 3_600_000;
export type ReportWindow = {
  kind: ReportKind; timezone: 'Asia/Shanghai';
  fromDate: string; toDateExclusive: string; start: string; end: string;
};
export type LifeReportPreview = {
  version: 1; ownerId: number; generatedAt: string; period: ReportWindow;
  coverage: 'server-synced-only'; mode: 'statistics-preview';
  achievementsRecorded: number; tasksCompleted: number; ideasCreated: number;
  focus: { completedSessions: number; recordedMinutes: number; earlySessions: number };
  habitCompletions: number; daysWithNotes: number;
  aiEnabled: false; emailEnabled: false;
};

/** Most recent COMPLETE day/week in modern Asia/Shanghai (UTC+8). */
export function reportWindow(kind: ReportKind, now = new Date()): ReportWindow {
  if ((kind !== 'daily' && kind !== 'weekly') || !Number.isFinite(now.getTime()) || now.getUTCFullYear() < 2000) {
    throw new Error('Invalid report period');
  }
  const localMidnight = Math.floor((now.getTime() + SHANGHAI_OFFSET) / DAY) * DAY;
  const weekday = new Date(localMidnight).getUTCDay();
  const endLocal = kind === 'daily' ? localMidnight : localMidnight - ((weekday + 6) % 7) * DAY;
  const startLocal = endLocal - (kind === 'daily' ? DAY : 7 * DAY);
  return {
    kind, timezone: 'Asia/Shanghai',
    fromDate: new Date(startLocal).toISOString().slice(0, 10),
    toDateExclusive: new Date(endLocal).toISOString().slice(0, 10),
    start: new Date(startLocal - SHANGHAI_OFFSET).toISOString(),
    end: new Date(endLocal - SHANGHAI_OFFSET).toISOString(),
  };
}

type Owned = { ownerId: number };
type Timestamp = Date | string | null | undefined;
type Todo = Owned & { type: string; completed: number; createdAt: Timestamp; completedAt: Timestamp; deadlineAt: Timestamp };
type Session = Owned & { endedAt: Timestamp; focusMinutes: number; completed: number; completedEarly?: number };
export type ReportInput = {
  todos: readonly Todo[];
  sessions: readonly Session[];
  habitLogs: readonly (Owned & { date: string; completed: number })[];
  notes: readonly (Owned & { date: string; content: string })[];
};

/** Defense in depth only: callers MUST also constrain database reads by owner/date. */
export function summarizeLifeReport(ownerId: number, period: ReportWindow, input: ReportInput) {
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error('Authenticated report owner required');
  const start = Date.parse(period.start), end = Date.parse(period.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 7 * DAY) {
    throw new Error('Invalid report interval');
  }
  const inTime = (value: Timestamp) => {
    const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
    return time >= start && time < end;
  };
  const inDay = (date: string) => date >= period.fromDate && date < period.toDateExclusive;
  const todos = input.todos.filter(row => row.ownerId === ownerId);
  const completed = todos.filter(row => row.type !== 'daily' && row.completed === 1 && inTime(row.completedAt));
  const sessions = input.sessions.filter(row => row.ownerId === ownerId && row.completed === 1 && inTime(row.endedAt));
  return {
    formatVersion: 1,
    ownerId,
    period,
    coverage: 'server-synced-only',
    // Success-column records and completed tasks overlap: a single count, never their sum.
    achievementsRecorded: completed.length,
    tasksCompleted: completed.filter(row => row.type === 'task').length,
    ideasCreated: todos.filter(row => row.type === 'learn' && inTime(row.createdAt)).length,
    focus: {
      completedSessions: sessions.length,
      recordedMinutes: sessions.reduce((sum, row) => sum + (Number.isFinite(row.focusMinutes) && row.focusMinutes >= 0 ? row.focusMinutes : 0), 0),
      earlySessions: sessions.filter(row => row.completedEarly === 1).length,
    },
    habitCompletions: input.habitLogs.filter(row => row.ownerId === ownerId && row.completed === 1 && inDay(row.date)).length,
    daysWithNotes: new Set(input.notes.filter(row => row.ownerId === ownerId && inDay(row.date) && row.content.trim()).map(row => row.date)).size,
    // Current source state cannot reconstruct past deadlines, completion reversals or active-habit denominators.
    limitations: ['unsynced-local-records-excluded', 'current-record-state-not-event-history', 'daily-checklist-is-not-a-habit-rate'],
  };
}

/** Strict projection prevents new caller fields (e.g. diary text) entering history. */
export function reportSnapshot(ownerId:number,value:LifeReportPreview):LifeReportPreview {
  if(!Number.isSafeInteger(ownerId)||ownerId<=0||value?.ownerId!==ownerId)throw Error('Report owner mismatch');
  const p=value.period;
  const start=Date.parse(p?.start),end=Date.parse(p?.end),generated=Date.parse(value.generatedAt);
  const duration=p?.kind==='daily'?DAY:p?.kind==='weekly'?7*DAY:NaN;
  if(value.version!==1||p?.timezone!=='Asia/Shanghai'||!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(generated)||end-start!==duration||generated<end||(start+SHANGHAI_OFFSET)%DAY!==0||
    (p.kind==='weekly'&&new Date(start+SHANGHAI_OFFSET).getUTCDay()!==1)||
    p.fromDate!==new Date(start+SHANGHAI_OFFSET).toISOString().slice(0,10)||p.toDateExclusive!==new Date(end+SHANGHAI_OFFSET).toISOString().slice(0,10))throw Error('Invalid report period');
  const counts=[value.achievementsRecorded,value.tasksCompleted,value.ideasCreated,value.habitCompletions,value.daysWithNotes,value.focus?.completedSessions,value.focus?.recordedMinutes,value.focus?.earlySessions];
  if(value.coverage!=='server-synced-only'||value.mode!=='statistics-preview'||value.aiEnabled!==false||value.emailEnabled!==false||counts.some(n=>!Number.isSafeInteger(n)||n<0)||value.tasksCompleted>value.achievementsRecorded||value.focus.earlySessions>value.focus.completedSessions)throw Error('Invalid report facts');
  return {version:1,ownerId,generatedAt:value.generatedAt,
    period:{kind:p.kind,timezone:'Asia/Shanghai',fromDate:p.fromDate,toDateExclusive:p.toDateExclusive,start:p.start,end:p.end},
    coverage:'server-synced-only',mode:'statistics-preview',achievementsRecorded:value.achievementsRecorded,tasksCompleted:value.tasksCompleted,ideasCreated:value.ideasCreated,
    focus:{completedSessions:value.focus.completedSessions,recordedMinutes:value.focus.recordedMinutes,earlySessions:value.focus.earlySessions},
    habitCompletions:value.habitCompletions,daysWithNotes:value.daysWithNotes,aiEnabled:false,emailEnabled:false};
}
