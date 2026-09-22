import { and, desc, eq, gte, isNotNull, lt, lte, or } from 'drizzle-orm';
import Elysia, { t } from 'elysia';
import { habitLogs, habits, pomodoroSessions, rssItems, users } from '../db/schema';
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

                const [user, ownerHabits, logs, sessions, items] = await Promise.all([
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
                };
            }, {
                query: t.Object({
                    dayStart: t.String(),
                    dayEnd: t.String(),
                    weekStart: t.String({ pattern: dayPattern }),
                    weekEnd: t.String({ pattern: dayPattern }),
                }),
            })
            .get('/calendar', async ({ uid, lifeAccess, set, query }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const range = validRange(query.start, query.end);
                if (!range) {
                    set.status = 400;
                    return 'Invalid date range';
                }
                const [ownerHabits, logs, sessions, rss] = await Promise.all([
                    db.query.habits.findMany({ where: eq(habits.ownerId, uid!) }),
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
                ]);
                return { habits: ownerHabits, logs, sessions, rss };
            }, { query: t.Object({ month: t.String({ pattern: monthPattern }), start: t.String(), end: t.String() }) })
            .get('/year', async ({ uid, lifeAccess, set, query }) => {
                if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
                const range = validRange(query.start, query.end);
                if (!range) {
                    set.status = 400;
                    return 'Invalid date range';
                }
                const [logs, sessions, rss] = await Promise.all([
                    db.query.habitLogs.findMany({ where: and(eq(habitLogs.ownerId, uid!), gte(habitLogs.date, `${query.year}-01-01`), lte(habitLogs.date, `${query.year}-12-31`)), columns: { date: true, completed: true } }),
                    db.query.pomodoroSessions.findMany({ where: and(eq(pomodoroSessions.ownerId, uid!), gte(pomodoroSessions.startedAt, range.start), lt(pomodoroSessions.startedAt, range.end)), columns: { startedAt: true, completed: true }, limit: 2000 }),
                    db.query.rssItems.findMany({
                        where: and(eq(rssItems.ownerId, uid!), or(
                            and(isNotNull(rssItems.readAt), gte(rssItems.readAt, range.start), lt(rssItems.readAt, range.end)),
                            and(isNotNull(rssItems.starredAt), gte(rssItems.starredAt, range.start), lt(rssItems.starredAt, range.end)),
                        )),
                        columns: { readAt: true, starredAt: true },
                        limit: 3000,
                    }),
                ]);
                return { logs, sessions, rss };
            }, { query: t.Object({ year: t.String({ pattern: yearPattern }), start: t.String(), end: t.String() }) }),
        );
}
