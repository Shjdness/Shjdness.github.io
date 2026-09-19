import { and, eq } from 'drizzle-orm';
import Elysia, { t } from 'elysia';
import { habitLogs, habits } from '../db/schema';
import { setup } from '../setup';
import { getDB } from '../utils/di';

const day = t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });

/** Habit logs are the single source for future calendar/year views and timers. */
export function HabitService() {
  const db = getDB();
  return new Elysia({ aot: false }).use(setup()).group('/habit', group => group
    .get('/', async ({ uid, lifeAccess, set }) => {
      if (!uid || !lifeAccess) { set.status = 403; return 'Private Life access is required'; }
      return db.query.habits.findMany({ where: eq(habits.ownerId, uid), orderBy: (habits, { desc }) => [desc(habits.active), desc(habits.createdAt)] });
    })
    .post('/', async ({ uid, lifeAccess, set, body }) => {
      if (!uid || !lifeAccess) { set.status = 403; return 'Private Life access is required'; }
      const result = await db.insert(habits).values({ ownerId: uid, ...body }).returning({ insertedId: habits.id });
      return result[0];
    }, { body: t.Object({ name: t.String({ minLength: 1, maxLength: 80 }), description: t.Optional(t.String({ maxLength: 240 })), color: t.Optional(t.String({ maxLength: 16 })) }) })
    .post('/:id/toggle', async ({ uid, lifeAccess, set, params, body }) => {
      if (!uid || !lifeAccess) { set.status = 403; return 'Private Life access is required'; }
      const habitId = Number.parseInt(params.id, 10);
      const habit = await db.query.habits.findFirst({ where: and(eq(habits.id, habitId), eq(habits.ownerId, uid)) });
      if (!habit) { set.status = 404; return 'Habit not found'; }
      await db.insert(habitLogs).values({ habitId, ownerId: uid, date: body.date, completed: body.completed ? 1 : 0, note: body.note || '' }).onConflictDoUpdate({ target: [habitLogs.habitId, habitLogs.date], set: { completed: body.completed ? 1 : 0, note: body.note || '', updatedAt: new Date() } });
      return 'OK';
    }, { body: t.Object({ date: day, completed: t.Boolean(), note: t.Optional(t.String({ maxLength: 500 })) }) })
    .get('/calendar', async ({ uid, lifeAccess, set, query }) => {
      if (!uid || !lifeAccess) { set.status = 403; return 'Private Life access is required'; }
      const prefix = `${query.month}-`;
      const ownerHabits = await db.query.habits.findMany({ where: eq(habits.ownerId, uid) });
      const logs = await db.query.habitLogs.findMany({ where: eq(habitLogs.ownerId, uid) });
      return { habits: ownerHabits, logs: logs.filter(log => log.date.startsWith(prefix)) };
    }, { query: t.Object({ month: t.String({ pattern: '^\\d{4}-\\d{2}$' }) }) })
  );
}
