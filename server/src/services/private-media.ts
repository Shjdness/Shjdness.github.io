import Elysia from 'elysia';
import { setup } from '../setup';
import { getEnv } from '../utils/di';
import { imageFormat } from '../utils/image-format';
import { allowBurst } from '../utils/rate-limit';
import { hasBodyLimitError, readLimitedBody } from '../utils/request-body';

const maxImageBytes = 5 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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

/** Owner-scoped staging only. Content binding and publication are separate. */
export function PrivateMediaService() {
    const bucket = getEnv().PRIVATE_MEDIA;
    return new Elysia({ aot: false })
        .use(setup())
        .group('/storage/private', group => group
            .get('/:id', async ({ uid, writer, params, request }) => {
                if (!bucket) return reply(404);
                if (!uid || !writer) return reply(401);
                if (!uuid.test(params.id) || !new URL(request.url).pathname.endsWith(`/${params.id}`)) return reply(404);
                try {
                    const object = await bucket.get(`owner/${uid}/${params.id}`);
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
                if (!uuid.test(params.id) || !new URL(request.url).pathname.endsWith(`/${params.id}`)) return reply(404);
                if (!allowBurst(`private-media-put:${uid}`, 12)) {
                    return new Response(null, { status: 429, headers: { ...privateHeaders, 'Retry-After': '60' } });
                }
                try {
                    const bytes = await readLimitedBody(request, maxImageBytes);
                    const format = imageFormat(bytes);
                    if (!format) return reply(415);
                    const digest = digestHex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
                    const key = `owner/${uid}/${params.id}`;
                    const written = await bucket.put(key, bytes, {
                        onlyIf: { etagDoesNotMatch: '*' },
                        httpMetadata: { contentType: format.contentType },
                        customMetadata: { digest },
                    });
                    if (written) return Response.json({ id: params.id }, { status: 201, headers: privateHeaders });
                    const existing = await bucket.head(key);
                    if (!existing) return reply(503);
                    if (existing.size !== bytes.length || existing.customMetadata?.digest !== digest || existing.httpMetadata?.contentType !== format.contentType) return reply(409);
                    return Response.json({ id: params.id }, { headers: privateHeaders });
                } catch (error) { return reply(hasBodyLimitError(error) ? 413 : 503); }
            // Elysia's dynamic handler falls back to MIME-based parsing when
            // the custom parser returns undefined, so use an explicit marker.
            }, { parse: () => ({}) }));
}
