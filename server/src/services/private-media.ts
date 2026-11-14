import Elysia from 'elysia';
import { eq } from 'drizzle-orm';
import { feeds } from '../db/schema';
import { setup } from '../setup';
import { getDB, getEnv } from '../utils/di';
import { canReadFeed, isPrivateFeed } from '../utils/feed-permissions';
import { imageFormat } from '../utils/image-format';
import { reservePrivateMediaUpload } from '../utils/private-media-budget';
import { feedReferencesPrivateMedia, privateMediaId, privateMediaKey } from '../utils/private-media-reference';
import { allowBurst } from '../utils/rate-limit';
import { hasBodyLimitError, readLimitedBody } from '../utils/request-body';

const maxImageBytes = 5 * 1024 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const privateHeaders = {
    'Cache-Control': 'private, no-store',
    'Vary': 'Origin, Authorization',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
};

function reply(status: number) {
    return new Response(null, { status, headers: privateHeaders });
}

function digestHex(bytes: ArrayBuffer) {
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validObjectType(value: string | undefined): value is string {
    return value !== undefined && imageTypes.has(value);
}

export function PrivateMediaService() {
    const { PRIVATE_MEDIA: bucket, DB: budgetDb } = getEnv();
    const db = getDB();
    return new Elysia({ aot: false })
        .use(setup())
        .group('/storage/private', group => group
            .get('/:id', async ({ uid, writer, admin, params, request }) => {
                if (!bucket) return reply(404);
                if (!uid || !writer) return reply(401);
                const url = new URL(request.url);
                if (!privateMediaId.test(params.id) || !url.pathname.endsWith(`/${params.id}`)) return reply(404);
                try {
                    // Without a feed ID, access is limited to the upload owner's staging namespace.
                    let ownerId = uid;
                    const feedIds = url.searchParams.getAll('feedId');
                    if (feedIds.length) {
                        const feedId = Number(feedIds[0]);
                        if (feedIds.length !== 1 || !Number.isSafeInteger(feedId) || feedId < 1 || String(feedId) !== feedIds[0]) return reply(404);
                        const feed = await db.query.feeds.findFirst({
                            columns: { uid: true, draft: true, kind: true, content: true },
                            where: eq(feeds.id, feedId),
                        });
                        if (!feed || !isPrivateFeed(feed) || !canReadFeed({ ownerId: feed.uid, viewerId: uid, admin, draft: feed.draft, kind: feed.kind })) return reply(404);
                        if (!feedReferencesPrivateMedia(feed.content, params.id)) return reply(404);
                        ownerId = feed.uid;
                    }
                    const object = await bucket.get(privateMediaKey(ownerId, params.id));
                    if (!object) return reply(404);
                    const type = object.httpMetadata?.contentType;
                    if (!validObjectType(type) || object.size < 1 || object.size > maxImageBytes) {
                        await object.body.cancel();
                        return reply(503);
                    }
                    // Workers and the compiler's web stream types differ structurally.
                    return new Response(object.body as unknown as BodyInit, {
                        headers: { ...privateHeaders, 'Content-Type': type },
                    });
                } catch { return reply(503); }
            })
            .put('/:id', async ({ uid, writer, params, request }) => {
                if (!bucket) return reply(404);
                if (!uid || !writer) return reply(401);
                if (!privateMediaId.test(params.id) || !new URL(request.url).pathname.endsWith(`/${params.id}`)) return reply(404);
                if (!allowBurst(`private-media-put:${uid}`, 12)) {
                    return new Response(null, { status: 429, headers: { ...privateHeaders, 'Retry-After': '60' } });
                }
                try {
                    const bytes = await readLimitedBody(request, maxImageBytes);
                    const format = imageFormat(bytes);
                    if (!format) return reply(415);
                    const digest = digestHex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
                    const key = privateMediaKey(uid, params.id);
                    const receipt = (status: number) => Response.json({ id: params.id }, { status, headers: privateHeaders });
                    const matches = (object: Pick<R2Object, 'size' | 'customMetadata' | 'httpMetadata'>) =>
                        object.size === bytes.length && object.customMetadata?.digest === digest && object.httpMetadata?.contentType === format.contentType;
                    const previous = await bucket.head(key);
                    if (previous) return matches(previous) ? receipt(200) : reply(409);

                    const budget = await reservePrivateMediaUpload(budgetDb, uid, bytes.length);
                    if (!budget.admitted) {
                        const retrySeconds = Math.max(1, Math.ceil((budget.retryAt - Date.now()) / 1000));
                        return Response.json({ code: 'PRIVATE_MEDIA_DAILY_LIMIT' }, {
                            status: 429, headers: { ...privateHeaders, 'Retry-After': String(retrySeconds) },
                        });
                    }
                    // A concurrent or previously unconfirmed PUT may still
                    // commit after HEAD. Keep the condition and never refund.
                    const written = await bucket.put(key, bytes, {
                        onlyIf: { etagDoesNotMatch: '*' },
                        httpMetadata: { contentType: format.contentType },
                        customMetadata: { digest },
                    });
                    if (written) return receipt(201);
                    const existing = await bucket.head(key);
                    if (!existing) return reply(503);
                    return matches(existing) ? receipt(200) : reply(409);
                } catch (error) { return reply(hasBodyLimitError(error) ? 413 : 503); }
            // Elysia's dynamic handler falls back to MIME-based parsing when
            // the custom parser returns undefined, so use an explicit marker.
            }, { parse: () => ({}) }));
}
