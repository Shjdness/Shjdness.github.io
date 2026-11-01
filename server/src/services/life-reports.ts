import Elysia, { t } from 'elysia';
import type {D1Database} from '@cloudflare/workers-types';
import { setup } from '../setup';
import { getEnv } from '../utils/di';
import { reportWindow, type ReportKind, type ReportWindow, type LifeReportPreview } from '../utils/life-report';
import {allowBurst} from '../utils/rate-limit';
import {decodeReportRow,findReportForPeriod,saveReportSnapshot} from '../utils/report-history';
import {readReportPreferences,reserveReportWrite,updateReportPreferences} from '../utils/report-settings';
import {REPORT_AI_MODEL,REPORT_AI_MONTHLY_FEN} from '../utils/report-ai';

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
  const env=getEnv(),db=env.DB;
  const authorize=({uid,admin,set}:{uid?:number;admin?:boolean;set:{headers:Record<string,unknown>;status?:number|string}})=>{
    set.headers['Cache-Control']='private, no-store, max-age=0';
    set.headers['Pragma']='no-cache';
    set.headers['Vary']='Origin, Authorization';
    if(!uid||!admin){set.status=403;return null;}return uid;
  };
  const kind=t.Optional(t.Union([t.Literal('daily'),t.Literal('weekly')]));
  return new Elysia({aot:false}).use(setup())
    .get('/life/reports/preview',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      if(!allowBurst(`life-report:${owner}`,6)){context.set.status=429;context.set.headers['Retry-After']='60';return 'Report refresh limit reached';}
      return previewLifeReport(db,owner,context.query.kind ?? 'daily');
    },{query:t.Object({kind})})
    .get('/life/reports/status',context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      return {ownerId:owner,deepseekConfigured:Boolean(env.DEEPSEEK_API_KEY?.trim()),apiVerified:false,aiEnabled:false,emailEnabled:false,automationEnabled:false,model:REPORT_AI_MODEL,monthlyBudgetFen:REPORT_AI_MONTHLY_FEN,aiScope:'statistics'};
    })
    .get('/life/reports/settings',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      return {ownerId:owner,preferences:await readReportPreferences(db,owner),automationEnabled:false};
    })
    .post('/life/reports/settings',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      if(!allowBurst(`life-report-write:${owner}`,10)){context.set.status=429;return 'Report write limit reached';}
      const result=await updateReportPreferences(db,owner,context.body);
      if(!result.saved)context.set.status=result.paused?503:409;
      return {ownerId:owner,...result,automationEnabled:false};
    },{body:t.Object({dailyTime:t.String({pattern:'^([01]\\d|2[0-3]):[0-5]\\d$'}),weeklyTime:t.String({pattern:'^([01]\\d|2[0-3]):[0-5]\\d$'}),weeklyDay:t.Integer({minimum:1,maximum:7}),baseRevision:t.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER})},{additionalProperties:false})})
    .post('/life/reports/history',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      if(!allowBurst(`life-report-save:${owner}`,6)){context.set.status=429;return 'Report save limit reached';}
      const now=new Date(),reportKind=context.body.kind??'daily',period=reportWindow(reportKind,now);
      const existing=await findReportForPeriod(db,owner,period);
      if(existing)return {ownerId:owner,saved:true,created:false,...existing};
      if(!await reserveReportWrite(db)){context.set.status=503;return {saved:false,code:'REPORT_WRITE_BUDGET_PAUSED'};}
      const stored=await saveReportSnapshot(db,owner,await previewLifeReport(db,owner,reportKind,now));
      return {ownerId:owner,saved:true,...stored};
    },{body:t.Object({kind},{additionalProperties:false})})
    .get('/life/reports/history',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      const before=context.query.before?Number(context.query.before):Number.MAX_SAFE_INTEGER;
      if(!Number.isSafeInteger(before)||before<1){context.set.status=400;return 'Invalid history cursor';}
      const result=await db.prepare('SELECT id,kind,period_start,period_end,created_at FROM life_reports WHERE owner_id=? AND id<? ORDER BY id DESC LIMIT 21').bind(owner,before).all();
      if(!result.success)throw Error('Report history unavailable');
      const items=result.results.slice(0,20);
      return {ownerId:owner,items,nextBefore:result.results.length>20?String(items[items.length-1].id):null};
    },{query:t.Object({before:t.Optional(t.String({pattern:'^[0-9]{1,16}$'}))})})
    .get('/life/reports/history/:id',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      const id=Number(context.params.id);if(!Number.isSafeInteger(id)||id<1){context.set.status=400;return 'Invalid report id';}
      const result=await db.prepare('SELECT id,kind,period_start,period_end,snapshot_json,snapshot_sha256 FROM life_reports WHERE owner_id=? AND id=?').bind(owner,id).all<Record<string,unknown>>();
      if(!result.success)throw Error('Report history unavailable');
      if(!result.results.length){context.set.status=404;return 'Report not found';}
      return {ownerId:owner,...await decodeReportRow(owner,result.results[0])};
    });
}
