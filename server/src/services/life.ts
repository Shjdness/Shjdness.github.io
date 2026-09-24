import { and, desc, eq, gte, isNotNull, lt, lte, or } from 'drizzle-orm';
import Elysia, { t } from 'elysia';
import { dailyBasics, habitLogs, habits, lifeDailyNotes, pomodoroSessions, rssItems, users } from '../db/schema';
import { setup } from '../setup';
import { getDB } from '../utils/di';
import { roleForUser } from '../utils/roles';

const dayPattern = '^\\d{4}-\\d{2}-\\d{2}$';
const monthPattern = '^\\d{4}-\\d{2}$';
const yearPattern = '^\\d{4}$';

function validRange(startValue: string, endValue: string) {
    const start = new Date(startValue);
    const end = new Date(endValue);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return null;
    return { start, end };
}

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
            .get('/overview', async ({ uid, lifeAccess, set, query }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const today = validRange(query.dayStart, query.dayEnd);
                if (!today || query.weekStart > query.weekEnd) {
                    set.status = 400;
                    return 'Invalid date range';
                }

                const [user, ownerHabits, logs, sessions, items, basics] = await Promise.all([
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
                ]);

                return {
                    role: roleForUser(user),
                    sections: ['overview', 'habits', 'calendar', 'pomodoro', 'rss'],
                    summary: {
                        habits: ownerHabits.length,
                        completed: logs.filter(log => log.completed).length,
                        focusMinutes: sessions.filter(session => session.completed).reduce((sum, session) => sum + session.focusMinutes, 0),
                        rounds: sessions.filter(session => session.completed).length,
                        unread: items.filter(item => !item.read).length,
                    },
                    habits: ownerHabits.map(habit => ({
                        id: habit.id,
                        name: habit.name,
                        days: logs.filter(log => log.habitId === habit.id && log.completed).map(log => log.date),
                    })),
                    recentRss: items.slice(0, 4).map(item => ({ id: item.id, title: item.title, url: item.url, publishedAt: item.publishedAt, read: item.read })),
                    basics,
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
            .get('/calendar', async ({ uid, lifeAccess, set, query }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const range = validRange(query.start, query.end);
                if (!range) {
                    set.status = 400;
                    return 'Invalid date range';
                }
                const [ownerHabits, logs, sessions, rss, notes, basics] = await Promise.all([
                    db.query.habits.findMany({ where: and(eq(habits.ownerId, uid!), eq(habits.active, 1)) }),
                    db.query.habitLogs.findMany({ where: and(eq(habitLogs.ownerId, uid!), gte(habitLogs.date, `${query.month}-01`), lte(habitLogs.date, `${query.month}-31`)) }),
                    db.query.pomodoroSessions.findMany({ where: and(eq(pomodoroSessions.ownerId, uid!), gte(pomodoroSessions.startedAt, range.start), lt(pomodoroSessions.startedAt, range.end)), orderBy: [desc(pomodoroSessions.startedAt)], limit: 500 }),
                    db.query.rssItems.findMany({
                        where: and(eq(rssItems.ownerId, uid!), or(
                            and(isNotNull(rssItems.readAt), gte(rssItems.readAt, range.start), lt(rssItems.readAt, range.end)),
                            and(isNotNull(rssItems.starredAt), gte(rssItems.starredAt, range.start), lt(rssItems.starredAt, range.end)),
                        )),
                        columns: { id: true, title: true, url: true, readAt: true, starredAt: true },
                        limit: 500,
                    }),
                    db.query.lifeDailyNotes.findMany({ where: and(eq(lifeDailyNotes.ownerId, uid!), gte(lifeDailyNotes.date, `${query.month}-01`), lte(lifeDailyNotes.date, `${query.month}-31`)) }),
                    db.query.dailyBasics.findMany({ where: and(eq(dailyBasics.ownerId, uid!), gte(dailyBasics.date, `${query.month}-01`), lte(dailyBasics.date, `${query.month}-31`)), orderBy: [dailyBasics.sortOrder] }),
                ]);
                return { habits: ownerHabits, logs, sessions, rss, notes, basics };
            }, { query: t.Object({ month: t.String({ pattern: monthPattern }), start: t.String(), end: t.String() }) })
            .get('/basics', async ({ uid, lifeAccess, set, query }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                return db.query.dailyBasics.findMany({ where: and(eq(dailyBasics.ownerId, uid!), gte(dailyBasics.date, query.from), lte(dailyBasics.date, query.to)), orderBy: [dailyBasics.date, dailyBasics.sortOrder] });
            }, { query: t.Object({ from: t.String({ pattern: dayPattern }), to: t.String({ pattern: dayPattern }) }) })
            .post('/basics', async ({ uid, lifeAccess, set, body }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const content = body.content.trim();
                if (body.clientKey) {
                    const existing = await db.query.dailyBasics.findFirst({ where: and(eq(dailyBasics.ownerId, uid!), eq(dailyBasics.clientKey, body.clientKey)) });
                    if (existing) return { insertedId: existing.id };
                }
                const duplicate = await db.query.dailyBasics.findFirst({ where: and(eq(dailyBasics.ownerId, uid!), eq(dailyBasics.date, body.date), eq(dailyBasics.content, content)) });
                if (duplicate) return { insertedId: duplicate.id };
                const result = await db.insert(dailyBasics).values({ ownerId: uid!, date: body.date, content, sortOrder: body.sortOrder, clientKey: body.clientKey }).returning({ insertedId: dailyBasics.id });
                return result[0];
            }, { body: t.Object({ date: t.String({ pattern: dayPattern }), content: t.String({ minLength: 1, maxLength: 240 }), sortOrder: t.Integer({ minimum: 0, maximum: 100 }), clientKey: t.Optional(t.String({ maxLength: 80 })) }) })
            .post('/basics/:id', async ({ uid, lifeAccess, set, params, body }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const id = Number(params.id);
                const existing = await db.query.dailyBasics.findFirst({ where: and(eq(dailyBasics.id, id), eq(dailyBasics.ownerId, uid!)) });
                if (!existing) { set.status = 404; return 'Today item not found'; }
                await db.update(dailyBasics).set({ content: body.content?.trim(), completed: body.completed === undefined ? undefined : body.completed ? 1 : 0, sortOrder: body.sortOrder, updatedAt: new Date() }).where(and(eq(dailyBasics.id, id), eq(dailyBasics.ownerId, uid!)));
                return 'OK';
            }, { body: t.Object({ content: t.Optional(t.String({ minLength: 1, maxLength: 240 })), completed: t.Optional(t.Boolean()), sortOrder: t.Optional(t.Integer({ minimum: 0, maximum: 100 })) }) })
            .delete('/basics/:id', async ({ uid, lifeAccess, set, params }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const result = await db.delete(dailyBasics).where(and(eq(dailyBasics.id, Number(params.id)), eq(dailyBasics.ownerId, uid!))).returning({ id: dailyBasics.id });
                if (!result.length) { set.status = 404; return 'Today item not found'; }
                return 'OK';
            })
            .get('/notes', async ({ uid, lifeAccess, set, query }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                return db.query.lifeDailyNotes.findMany({ where: and(eq(lifeDailyNotes.ownerId, uid!), gte(lifeDailyNotes.date, query.from), lte(lifeDailyNotes.date, query.to)) });
            }, { query: t.Object({ from: t.String({ pattern: dayPattern }), to: t.String({ pattern: dayPattern }) }) })
            .post('/notes/:date', async ({ uid, lifeAccess, set, params, body }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const incoming = new Date(body.updatedAt);
                if (!Number.isFinite(incoming.getTime())) { set.status = 400; return 'Invalid updatedAt'; }
                const existing = await db.query.lifeDailyNotes.findFirst({ where: and(eq(lifeDailyNotes.ownerId, uid!), eq(lifeDailyNotes.date, params.date)) });
                if (existing && existing.updatedAt.getTime() > incoming.getTime()) return { saved: false, note: existing };
                await db.insert(lifeDailyNotes).values({ ownerId: uid!, date: params.date, content: body.content, updatedAt: incoming }).onConflictDoUpdate({ target: [lifeDailyNotes.ownerId, lifeDailyNotes.date], set: { content: body.content, updatedAt: incoming } });
                const note = await db.query.lifeDailyNotes.findFirst({ where: and(eq(lifeDailyNotes.ownerId, uid!), eq(lifeDailyNotes.date, params.date)) });
                return { saved: true, note };
            }, { params: t.Object({ date: t.String({ pattern: dayPattern }) }), body: t.Object({ content: t.String({ maxLength: 2000 }), updatedAt: t.String() }) })
            .delete('/notes/:date', async ({ uid, lifeAccess, set, params }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                await db.delete(lifeDailyNotes).where(and(eq(lifeDailyNotes.ownerId, uid!), eq(lifeDailyNotes.date, params.date)));
                return 'OK';
            }, { params: t.Object({ date: t.String({ pattern: dayPattern }) }) })
            .get('/year', async ({ uid, lifeAccess, set, query }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const range = validRange(query.start, query.end);
                if (!range) {
                    set.status = 400;
                    return 'Invalid date range';
                }
                const [ownerHabits, logs, sessions, rss, basics] = await Promise.all([
                    db.query.habits.findMany({ where: eq(habits.ownerId, uid!), columns: { id: true, name: true } }),
                    db.query.habitLogs.findMany({ where: and(eq(habitLogs.ownerId, uid!), gte(habitLogs.date, `${query.year}-01-01`), lte(habitLogs.date, `${query.year}-12-31`)), columns: { habitId: true, date: true, completed: true } }),
                    db.query.pomodoroSessions.findMany({ where: and(eq(pomodoroSessions.ownerId, uid!), gte(pomodoroSessions.startedAt, range.start), lt(pomodoroSessions.startedAt, range.end)), columns: { startedAt: true, focusMinutes: true, completed: true }, limit: 2000 }),
                    db.query.rssItems.findMany({
                        where: and(eq(rssItems.ownerId, uid!), or(
                            and(isNotNull(rssItems.readAt), gte(rssItems.readAt, range.start), lt(rssItems.readAt, range.end)),
                            and(isNotNull(rssItems.starredAt), gte(rssItems.starredAt, range.start), lt(rssItems.starredAt, range.end)),
                        )),
                        columns: { readAt: true, starredAt: true },
                        limit: 3000,
                    }),
                    db.query.dailyBasics.findMany({ where: and(eq(dailyBasics.ownerId, uid!), gte(dailyBasics.date, `${query.year}-01-01`), lte(dailyBasics.date, `${query.year}-12-31`)), columns: { date: true, completed: true } }),
                ]);
                return { habits: ownerHabits, logs, sessions, rss, basics };
            }, { query: t.Object({ year: t.String({ pattern: yearPattern }), start: t.String(), end: t.String() }) }),
        );
}
