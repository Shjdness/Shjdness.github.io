import Elysia, { t } from 'elysia';
import type {D1Database} from '@cloudflare/workers-types';
import { setup } from '../setup';
import { getEnv } from '../utils/di';
import { reportWindow, type ReportKind, type ReportWindow, type LifeReportPreview } from '../utils/life-report';
import {allowBurst} from '../utils/rate-limit';

// Parameters are only the authenticated uid and server-computed complete period.
// Each statement returns a single aggregate row; no task or diary body leaves D1.
export function reportQueries(ownerId: number, period: ReportWindow) {
  const start = Date.parse(period.start) / 1000, end = Date.parse(period.end) / 1000;
  return [
    { sql: `SELECT
        COALESCE(SUM(CASE WHEN type <> 'daily' AND completed=1 AND completed_at>=? AND completed_at<? THEN 1 ELSE 0 END),0) AS achievements,
        COALESCE(SUM(CASE WHEN type='task' AND completed=1 AND completed_at>=? AND completed_at<? THEN 1 ELSE 0 END),0) AS tasks,
        COALESCE(SUM(CASE WHEN type='learn' AND created_at>=? AND created_at<? THEN 1 ELSE 0 END),0) AS ideas
      FROM life_todos WHERE owner_id=? AND ((completed_at>=? AND completed_at<?) OR (created_at>=? AND created_at<?))`,
      args: [start,end,start,end,start,end,ownerId,start,end,start,end] },
    { sql: `SELECT COUNT(*) AS sessions, COALESCE(SUM(CASE WHEN focus_minutes>=0 THEN focus_minutes ELSE 0 END),0) AS minutes,
        COALESCE(SUM(CASE WHEN completed_early=1 THEN 1 ELSE 0 END),0) AS early
      FROM pomodoro_sessions WHERE owner_id=? AND completed=1 AND ended_at>=? AND ended_at<?`, args: [ownerId,start,end] },
    { sql: 'SELECT COUNT(*) AS habits FROM habit_logs WHERE owner_id=? AND completed=1 AND date>=? AND date<?', args: [ownerId,period.fromDate,period.toDateExclusive] },
    // Match JS String.trim whitespace, not only SQLite's default ASCII space.
    { sql: `SELECT COUNT(*) AS notes FROM life_daily_notes WHERE owner_id=? AND date>=? AND date<?
      AND length(trim(content, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))>0`, args: [ownerId,period.fromDate,period.toDateExclusive] },
  ];
}

export async function previewLifeReport(db: D1Database, ownerId: number, kind: ReportKind, now = new Date()): Promise<LifeReportPreview> {
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw Error('Report owner required');
  const period = reportWindow(kind, now);
  const rows = await db.batch<Record<string,number>>(reportQueries(ownerId,period).map(query=>db.prepare(query.sql).bind(...query.args)));
  if(rows.some(row=>!row.success)) throw Error('Report snapshot unavailable');
  const [todos,focus,habits,notes]=rows.map(row=>row.results[0]);
  if(!todos||!focus||!habits||!notes)throw Error('Incomplete report snapshot');
  return {
    version:1, ownerId, generatedAt:now.toISOString(), period, coverage:'server-synced-only', mode:'statistics-preview',
    achievementsRecorded:todos.achievements, tasksCompleted:todos.tasks, ideasCreated:todos.ideas,
    focus:{completedSessions:focus.sessions,recordedMinutes:focus.minutes,earlySessions:focus.early},
    habitCompletions:habits.habits,daysWithNotes:notes.notes,aiEnabled:false,emailEnabled:false,
  };
}

export function LifeReportsService() {
  const db=getEnv().DB;
  return new Elysia({aot:false}).use(setup()).get('/life/reports/preview',async({uid,admin,set,query})=>{
    set.headers['Cache-Control']='private, no-store, max-age=0';
    set.headers['Pragma']='no-cache';
    set.headers['Vary']='Origin, Authorization';
    if(!uid||!admin){set.status=403;return 'Owner access is required';}
    if(!allowBurst(`life-report:${uid}`,6)){set.status=429;set.headers['Retry-After']='60';return 'Report refresh limit reached';}
    return previewLifeReport(db,uid,query.kind ?? 'daily');
  },{query:t.Object({kind:t.Optional(t.Union([t.Literal('daily'),t.Literal('weekly')]))})});
}
