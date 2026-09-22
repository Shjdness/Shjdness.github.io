import { and, desc, eq, gte, lt } from 'drizzle-orm';
import Elysia, { t } from 'elysia';
import { pomodoroSessions } from '../db/schema';
import { setup } from '../setup';
import { getDB } from '../utils/di';

export function PomodoroService() {
  const db = getDB();
  return new Elysia({ aot: false }).use(setup()).group('/pomodoro', group => group
    .get('/sessions', async ({ uid, lifeAccess, set, query }) => {
      if (!uid || !lifeAccess) { set.status = 403; return 'Private Life access is required'; }
      const month = query.month || new Date().toISOString().slice(0, 7);
      const start = new Date(`${month}-01T00:00:00`);
      const end = new Date(start); end.setMonth(end.getMonth() + 1);
      return db.query.pomodoroSessions.findMany({
        where: and(eq(pomodoroSessions.ownerId, uid), gte(pomodoroSessions.startedAt, start), lt(pomodoroSessions.startedAt, end)),
        orderBy: [desc(pomodoroSessions.startedAt)],
        limit: 500,
      });
    }, { query: t.Object({ month: t.Optional(t.String({ pattern: '^\\d{4}-\\d{2}$' })) }) })
    .post('/sessions', async ({ uid, lifeAccess, set, body }) => {
      if (!uid || !lifeAccess) { set.status = 403; return 'Private Life access is required'; }
      const startedAt = new Date(body.startedAt); const endedAt = new Date(body.endedAt);
      if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(endedAt.getTime()) || endedAt <= startedAt) { set.status = 400; return 'Invalid session time'; }
      const result = await db.insert(pomodoroSessions).values({
        ownerId: uid, startedAt, endedAt, focusMinutes: body.focusMinutes,
        breakMinutes: body.breakMinutes, roundIndex: body.roundIndex, completed: body.completed ? 1 : 0,
        taskName: body.taskName || '', completedEarly: body.completedEarly ? 1 : 0,
      }).returning({ id: pomodoroSessions.id });
      return result[0];
    }, { body: t.Object({
      startedAt: t.String(), endedAt: t.String(),
      focusMinutes: t.Integer({ minimum: 1, maximum: 180 }),
      breakMinutes: t.Integer({ minimum: 1, maximum: 60 }),
      roundIndex: t.Integer({ minimum: 1, maximum: 20 }),
      completed: t.Boolean(),
      taskName: t.Optional(t.String({ maxLength: 160 })),
      completedEarly: t.Optional(t.Boolean()),
    }) })
  );
}
