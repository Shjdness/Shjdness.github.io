import { eq } from 'drizzle-orm';
import Elysia from 'elysia';
import { setup } from '../setup';
import { users } from '../db/schema';
import { getDB } from '../utils/di';
import { roleForUser } from '../utils/roles';

/**
 * Private Life entry point. New Life modules attach here so the backend—not
 * only the client router—remains default-deny for visitors and members.
 */
export function LifeService() {
    const db = getDB();
    return new Elysia({ aot: false })
        .use(setup())
        .group('/life', group => group
            .get('/overview', async ({ uid, lifeAccess, set }) => {
                if (!uid || !lifeAccess) {
                    set.status = 403;
                    return 'Private Life access is required';
                }
                const user = await db.query.users.findFirst({ where: eq(users.id, uid) });
                return {
                    role: roleForUser(user),
                    sections: ['habits', 'calendar', 'year', 'rss'],
                };
            })
        );
}
