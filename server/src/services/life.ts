import { and, desc, eq, gte, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import Elysia, { t } from 'elysia';
import { dailyBasics, habitLogs, habits, lifeDailyNotes, lifeTodos, pomodoroSessions, rssItems, users } from '../db/schema';
import { setup } from '../setup';
import { getDB, getEnv } from '../utils/di';
import { roleForUser } from '../utils/roles';
import { todoState } from '../utils/todo-state';
import {createDailyPlan,updateDailyPlan,reorderDailyPlan,validPlanDay} from '../utils/daily-plans';
import { lifeCalendarWindow, lifeOverviewWindow, validLifeDaySpan } from '../utils/life-date-range';

const dayPattern = '^\\d{4}-\\d{2}-\\d{2}$';
const monthPattern = '^\\d{4}-\\d{2}$';
const yearPattern = '^\\d{4}$';
const todoType = t.Union([t.Literal('task'), t.Literal('learn'), t.Literal('success'), t.Literal('daily')]);
const optionalTodoDate = t.Optional(t.Union([t.String({ format: 'date-time' }), t.Null()]));

/**
 * Aggregated Life reads live here so the browser does not need to coordinate
 * several Worker requests. Every query remains owner-scoped and default-deny.
 */
export function LifeService() {
    const db = getDB();
    const requireLife = ({ uid, lifeAccess, set }: { uid?: number; lifeAccess?: boolean; set: { status?: number | string } }) => {
        if (!uid || !lifeAccess) {
            set.status = 403;
            return false;
        }
        return true;
    };

    return new Elysia({ aot: false })
        .use(setup())
        .group('/life', group => group
            .get('/todo-capabilities', () => ({ version: 2 }))
            .get('/overview', async ({ uid, lifeAccess, set, query }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const today = lifeOverviewWindow(query);
                if (!today) {
                    set.status = 400;
                    return 'Invalid date range';
                }

                const [user, ownerHabits, logs, sessions, items, basics, todos, unread] = await Promise.all([
                    db.query.users.findFirst({ where: eq(users.id, uid!) }),
                    db.query.habits.findMany({ where: and(eq(habits.ownerId, uid!), eq(habits.active, 1)) }),
                    db.query.habitLogs.findMany({
                        where: and(eq(habitLogs.ownerId, uid!), gte(habitLogs.date, query.weekStart), lte(habitLogs.date, query.weekEnd)),
                    }),
                    db.query.pomodoroSessions.findMany({
                        where: and(eq(pomodoroSessions.ownerId, uid!), gte(pomodoroSessions.startedAt, today.start), lt(pomodoroSessions.startedAt, today.end)),
                        orderBy: [desc(pomodoroSessions.startedAt)],
                        limit: 50,
                    }),
                    db.query.rssItems.findMany({
                        where: eq(rssItems.ownerId, uid!),
                        orderBy: [desc(rssItems.publishedAt)],
                        limit: 120,
                    }),
                    db.query.dailyBasics.findMany({ where: and(eq(dailyBasics.ownerId, uid!), eq(dailyBasics.date, query.day)), orderBy: [dailyBasics.sortOrder] }),
                    db.query.lifeTodos.findMany({ where: eq(lifeTodos.ownerId, uid!), orderBy: [lifeTodos.completed, desc(lifeTodos.updatedAt)], limit: 8 }),
                    db.select({value:sql<number>`count(*)`}).from(rssItems).where(and(eq(rssItems.ownerId,uid!),eq(rssItems.read,0))),
                ]);

                return {
                    role: roleForUser(user),
                    sections: ['overview', 'habits', 'calendar', 'pomodoro', 'rss'],
                    summary: {
                        habits: ownerHabits.length,
                        completed: logs.filter(log => log.completed).length,
                        focusMinutes: sessions.filter(session => session.completed).reduce((sum, session) => sum + session.focusMinutes, 0),
                        rounds: sessions.filter(session => session.completed).length,
                        unread: unread[0]?.value || 0,
                    },
                    habits: ownerHabits.map(habit => ({
                        id: habit.id,
                        name: habit.name,
                        days: logs.filter(log => log.habitId === habit.id && log.completed).map(log => log.date),
                    })),
                    recentRss: items.slice(0, 4).map(item => ({ id: item.id, title: item.title, url: item.url, publishedAt: item.publishedAt, read: item.read })),
                    basics,
                    todos,
                };
            }, {
                query: t.Object({
                    dayStart: t.String(),
                    dayEnd: t.String(),
                    weekStart: t.String({ pattern: dayPattern }),
                    weekEnd: t.String({ pattern: dayPattern }),
                    day: t.String({ pattern: dayPattern }),
                }),
            })
            .get('/todos', async ({ uid, lifeAccess, set }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const [todos, focus] = await Promise.all([
                    db.query.lifeTodos.findMany({ where: eq(lifeTodos.ownerId, uid!), orderBy: [lifeTodos.completed, desc(lifeTodos.updatedAt)] }),
                    db.select({ todoId: pomodoroSessions.todoId, minutes: sql<number>`sum(${pomodoroSessions.focusMinutes})`, rounds: sql<number>`count(*)` })
                        .from(pomodoroSessions)
                        .where(and(eq(pomodoroSessions.ownerId, uid!), eq(pomodoroSessions.completed, 1), isNotNull(pomodoroSessions.todoId)))
                        .groupBy(pomodoroSessions.todoId),
                ]);
                const byTodo = new Map(focus.map(row => [row.todoId, row]));
                return todos.map(todo => ({ ...todo, focusMinutes: byTodo.get(todo.id)?.minutes ?? 0, focusRounds: byTodo.get(todo.id)?.rounds ?? 0 }));
            })
            .post('/todos', async ({ uid, lifeAccess, set, body }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                if (!body.content.trim()) { set.status = 400; return 'Content must not be blank'; }
                if (body.clientKey) {
                    const existing = await db.query.lifeTodos.findFirst({ where: and(eq(lifeTodos.ownerId, uid!), eq(lifeTodos.clientKey, body.clientKey)) });
                    if (existing) return { insertedId: existing.id };
                }
                const result = await db.insert(lifeTodos).values({ ownerId: uid!, content: body.content.trim(), clientKey: body.clientKey || null, ...todoState(undefined, body) }).onConflictDoNothing({ target: [lifeTodos.ownerId, lifeTodos.clientKey] }).returning({ insertedId: lifeTodos.id });
                if (result[0]) return result[0];
                const raced = body.clientKey ? await db.query.lifeTodos.findFirst({ where: and(eq(lifeTodos.ownerId, uid!), eq(lifeTodos.clientKey, body.clientKey)) }) : null;
                if (raced) return { insertedId: raced.id };
                set.status = 409; return 'Todo could not be saved';
            }, { body: t.Object({ content: t.String({ minLength: 1, maxLength: 500 }), type: todoType, clientKey: t.Optional(t.String({ maxLength: 80 })), deadlineAt: optionalTodoDate, completedAt: optionalTodoDate, sortOrder: t.Optional(t.Integer({ minimum: 0, maximum: 1000000 })) }) })
            .post('/todos/:id', async ({ uid, lifeAccess, set, params, body }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const id = Number(params.id);
                const existing = await db.query.lifeTodos.findFirst({ where: and(eq(lifeTodos.id, id), eq(lifeTodos.ownerId, uid!)) });
                if (!existing) { set.status = 404; return 'Todo not found'; }
                if (body.content !== undefined && !body.content.trim()) { set.status = 400; return 'Content must not be blank'; }
                await db.update(lifeTodos).set({ content: body.content?.trim(), ...todoState(existing, body), updatedAt: new Date() }).where(and(eq(lifeTodos.id, id), eq(lifeTodos.ownerId, uid!)));
                return 'OK';
            }, { body: t.Object({ content: t.Optional(t.String({ minLength: 1, maxLength: 500 })), type: t.Optional(todoType), completed: t.Optional(t.Boolean()), deadlineAt: optionalTodoDate, completedAt: optionalTodoDate, sortOrder: t.Optional(t.Integer({ minimum: 0, maximum: 1000000 })) }) })
            .delete('/todos/:id', async ({ uid, lifeAccess, set, params }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const removed = await db.delete(lifeTodos).where(and(eq(lifeTodos.id, Number(params.id)), eq(lifeTodos.ownerId, uid!))).returning({ id: lifeTodos.id });
                if (!removed.length) { set.status = 404; return 'Todo not found'; }
                return 'OK';
            })
            .get('/calendar', async ({ uid, lifeAccess, set, query }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const range = lifeCalendarWindow(query.month, query.start, query.end);
                if (!range) {
                    set.status = 400;
                    return 'Invalid date range';
                }
                const [ownerHabits, logs, sessions, notes, basics] = await Promise.all([
                    db.query.habits.findMany({ where: and(eq(habits.ownerId, uid!), eq(habits.active, 1)) }),
                    db.query.habitLogs.findMany({ where: and(eq(habitLogs.ownerId, uid!), gte(habitLogs.date, range.firstDay), lte(habitLogs.date, range.lastDay)) }),
                    db.query.pomodoroSessions.findMany({ where: and(eq(pomodoroSessions.ownerId, uid!), gte(pomodoroSessions.startedAt, range.start), lt(pomodoroSessions.startedAt, range.end)), orderBy: [desc(pomodoroSessions.startedAt)], limit: 500 }),
                    db.query.lifeDailyNotes.findMany({ where: and(eq(lifeDailyNotes.ownerId, uid!), gte(lifeDailyNotes.date, range.firstDay), lte(lifeDailyNotes.date, range.lastDay)) }),
                    db.query.dailyBasics.findMany({ where: and(eq(dailyBasics.ownerId, uid!), gte(dailyBasics.date, range.firstDay), lte(dailyBasics.date, range.lastDay)), orderBy: [dailyBasics.sortOrder] }),
                ]);
                return { habits: ownerHabits, logs, sessions, notes, basics };
            }, { query: t.Object({ month: t.String({ pattern: monthPattern }), start: t.String(), end: t.String() }) })
            .get('/basics', async ({ uid, lifeAccess, set, query }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                if (!validLifeDaySpan(query.from, query.to, 366)) { set.status = 400; return 'Invalid date range'; }
                return db.query.dailyBasics.findMany({ where: and(eq(dailyBasics.ownerId, uid!), gte(dailyBasics.date, query.from), lte(dailyBasics.date, query.to)), orderBy: [dailyBasics.date, dailyBasics.sortOrder] });
            }, { query: t.Object({ from: t.String({ pattern: dayPattern }), to: t.String({ pattern: dayPattern }) }) })
            .post('/basics', async ({ uid, lifeAccess, set, body }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                if(!validPlanDay(body.date)||!body.content.trim()){set.status=400;return '事项日期或内容无效';}
                const result=await createDailyPlan(getEnv().DB,uid!,body);
                if('conflict' in result)set.status=409;
                return result;
            }, { body: t.Object({ date: t.String({ pattern: dayPattern }), content: t.String({ minLength: 1, maxLength: 240 }), sortOrder: t.Integer({ minimum: 0, maximum: 100 }), clientKey: t.Optional(t.String({ maxLength: 80 })),todoId:t.Optional(t.Union([t.Integer({minimum:1}),t.Null()])) }) })
            .post('/basics/:id', async ({ uid, lifeAccess, set, params, body }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const id = Number(params.id);
                if(!Number.isSafeInteger(id)||id<1||(body.date!==undefined&&!validPlanDay(body.date))||(body.content!==undefined&&!body.content.trim())){set.status=400;return '事项日期或内容无效';}
                const result=await updateDailyPlan(getEnv().DB,uid!,id,body);
                if(!result.saved)set.status=result.missing?404:409;
                return result;
            }, { body: t.Object({ content: t.Optional(t.String({ minLength: 1, maxLength: 240 })), completed: t.Optional(t.Boolean()), sortOrder: t.Optional(t.Integer({ minimum: 0, maximum: 100 })),date:t.Optional(t.String({pattern:dayPattern})),todoId:t.Optional(t.Union([t.Integer({minimum:1}),t.Null()])),baseRevision:t.Optional(t.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER})) }) })
            .post('/basics/:id/reorder',async({uid,lifeAccess,set,params,body})=>{
                if(!requireLife({uid,lifeAccess,set}))return 'Private Life access is required';
                const id=Number(params.id);if(!Number.isSafeInteger(id)||id<1){set.status=400;return '事项无效';}
                return reorderDailyPlan(getEnv().DB,uid!,id,body.direction);
            },{body:t.Object({direction:t.Union([t.Literal(-1),t.Literal(1)])})})
            .delete('/basics/:id', async ({ uid, lifeAccess, set, params }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const result = await db.delete(dailyBasics).where(and(eq(dailyBasics.id, Number(params.id)), eq(dailyBasics.ownerId, uid!))).returning({ id: dailyBasics.id });
                if (!result.length) { set.status = 404; return 'Today item not found'; }
                return 'OK';
            })
            .get('/notes', async ({ uid, lifeAccess, set, query }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                if (!validLifeDaySpan(query.from, query.to, 366)) { set.status = 400; return 'Invalid date range'; }
                return db.query.lifeDailyNotes.findMany({ where: and(eq(lifeDailyNotes.ownerId, uid!), gte(lifeDailyNotes.date, query.from), lte(lifeDailyNotes.date, query.to)) });
            }, { query: t.Object({ from: t.String({ pattern: dayPattern }), to: t.String({ pattern: dayPattern }) }) })
            .post('/notes/:date', async ({ uid, lifeAccess, set, params, body }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const incoming = new Date(body.updatedAt);
                if (!Number.isFinite(incoming.getTime())) { set.status = 400; return 'Invalid updatedAt'; }
                const existing = await db.query.lifeDailyNotes.findFirst({ where: and(eq(lifeDailyNotes.ownerId, uid!), eq(lifeDailyNotes.date, params.date)) });
                if(existing?.content===body.content)return {saved:true,note:existing};
                if(existing && (body.baseRevision!==undefined ? existing.revision!==body.baseRevision : body.baseUpdatedAt ? existing.updatedAt.getTime()!==new Date(body.baseUpdatedAt).getTime() : existing.updatedAt.getTime()>incoming.getTime()))return {saved:false,note:existing};
                if(incoming.getTime()>Date.now()+300000) {set.status=400;return '设备时间超前，请校准后同步；本地修改已保留';}
                const updatedAt=Math.floor((body.baseUpdatedAt?Date.now():incoming.getTime())/1000);
                const result=await getEnv().DB.prepare(`INSERT INTO life_daily_notes(owner_id,date,content,updated_at) VALUES(?,?,?,?)
                    ON CONFLICT(owner_id,date) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at,revision=life_daily_notes.revision+1
                    WHERE life_daily_notes.revision=?`).bind(uid!,params.date,body.content,updatedAt,existing?.revision ?? -1).run();
                const note=await db.query.lifeDailyNotes.findFirst({where:and(eq(lifeDailyNotes.ownerId,uid!),eq(lifeDailyNotes.date,params.date))});
                return {saved:Number(result.meta.changes)>0,note};
            }, { params: t.Object({ date: t.String({ pattern: dayPattern }) }), body: t.Object({ content: t.String({ maxLength: 2000 }), updatedAt: t.String(), baseUpdatedAt:t.Optional(t.String({format:'date-time'})),baseRevision:t.Optional(t.Integer({minimum:0})) }) })
            .delete('/notes/:date', async ({ uid, lifeAccess, set, params }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                await db.delete(lifeDailyNotes).where(and(eq(lifeDailyNotes.ownerId, uid!), eq(lifeDailyNotes.date, params.date)));
                return 'OK';
            }, { params: t.Object({ date: t.String({ pattern: dayPattern }) }) })
            .get('/year', async ({ uid, lifeAccess, set, query }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const range = lifeCalendarWindow(query.year, query.start, query.end);
                if (!range) {
                    set.status = 400;
                    return 'Invalid date range';
                }
                const [ownerHabits, logs, sessions, rss, basics] = await Promise.all([
                    db.query.habits.findMany({ where: eq(habits.ownerId, uid!), columns: { id: true, name: true } }),
                    db.query.habitLogs.findMany({ where: and(eq(habitLogs.ownerId, uid!), gte(habitLogs.date, range.firstDay), lte(habitLogs.date, range.lastDay)), columns: { habitId: true, date: true, completed: true } }),
                    db.query.pomodoroSessions.findMany({ where: and(eq(pomodoroSessions.ownerId, uid!), gte(pomodoroSessions.startedAt, range.start), lt(pomodoroSessions.startedAt, range.end)), columns: { startedAt: true, focusMinutes: true, completed: true }, limit: 2000 }),
                    db.query.rssItems.findMany({
                        where: and(eq(rssItems.ownerId, uid!), or(
                            and(isNotNull(rssItems.readAt), gte(rssItems.readAt, range.start), lt(rssItems.readAt, range.end)),
                            and(isNotNull(rssItems.starredAt), gte(rssItems.starredAt, range.start), lt(rssItems.starredAt, range.end)),
                        )),
                        columns: { readAt: true, starredAt: true },
                        limit: 3000,
                    }),
                    db.query.dailyBasics.findMany({ where: and(eq(dailyBasics.ownerId, uid!), gte(dailyBasics.date, range.firstDay), lte(dailyBasics.date, range.lastDay)), columns: { date: true, completed: true } }),
                ]);
                return { habits: ownerHabits, logs, sessions, rss, basics };
            }, { query: t.Object({ year: t.String({ pattern: yearPattern }), start: t.String(), end: t.String() }) }),
        );
}
