import type { D1Database } from '@cloudflare/workers-types';

const accountAttempts = 40;
const accountBytes = 32 * 1024 * 1024;
const siteAttempts = 200;
const siteBytes = 128 * 1024 * 1024;

// Reserve both limits together. Materializing the predicate prevents the
// second row from being evaluated against values changed by this statement.
const reserve = `
WITH requested(scope, max_attempts, max_bytes) AS (
    VALUES ('site', ?, ?), (?, ?, ?)
), admitted AS MATERIALIZED (
    SELECT count(*) = 2 AS allowed
    FROM requested
    LEFT JOIN private_media_budget AS budget
        ON budget.day = ? AND budget.scope = requested.scope
    WHERE COALESCE(budget.attempts, 0) < requested.max_attempts
        AND COALESCE(budget.bytes, 0) + ? <= requested.max_bytes
)
INSERT INTO private_media_budget (day, scope, attempts, bytes)
SELECT ?, requested.scope, 1, ?
FROM requested CROSS JOIN admitted
WHERE admitted.allowed
ON CONFLICT (day, scope) DO UPDATE SET
    attempts = private_media_budget.attempts + 1,
    bytes = private_media_budget.bytes + excluded.bytes
RETURNING scope
`;

export async function reservePrivateMediaUpload(db: D1Database, ownerId: number, bytes: number, now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    const result = await db.prepare(reserve)
        .bind(siteAttempts, siteBytes, `owner:${ownerId}`, accountAttempts, accountBytes, day, bytes, day, bytes)
        .all<{ scope: string }>();
    if (result.results.length !== 0 && result.results.length !== 2) throw Error('Private media budget result invalid');
    const retryAt = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
    return { admitted: result.results.length === 2, retryAt };
}
