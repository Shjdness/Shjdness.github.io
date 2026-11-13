import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import worker from '../_worker';
import type { Env } from '../db/db';

const id = '784f0bfa-6d25-4a21-9f5c-f410fdb7822a';
const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const origin = 'https://site.invalid';
const secret = 'isolated-jwt-secret-at-least-32-characters';

function fixture() {
    const users = new Map([[1, 1], [2, 2], [3, 0]]);
    const feeds = new Map<number, { uid: number; draft: number; kind: string; content: string }>();
    const prepare = vi.fn((sql: string) => ({ bind: (id: number) => ({ raw: async () => {
        if (sql.includes('"info"')) return [['private:server.config:v1', '{}']];
        if (sql.includes('"feeds"')) {
            const feed = feeds.get(id);
            return feed ? [[feed.uid, feed.draft, feed.kind, feed.content]] : [];
        }
        if (!sql.includes('"users"')) throw Error('Unexpected database read');
        const role = users.get(id);
        return role === undefined ? [] : [[id, 'fixture', 'fixture', '', role, null, 0, 0]];
    } }) }));
    type Stored = { bytes: Uint8Array; size: number; httpMetadata: { contentType: string }; customMetadata: { digest: string } };
    const objects = new Map<string, Stored>();
    const bucket = {
        put: vi.fn(async (key: string, bytes: Uint8Array, opts: { onlyIf: { etagDoesNotMatch: string }; httpMetadata: Stored['httpMetadata']; customMetadata: Stored['customMetadata'] }) => {
            expect(opts.onlyIf).toEqual({ etagDoesNotMatch: '*' });
            if (objects.has(key)) return null;
            const record = { bytes, size: bytes.length, httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata };
            objects.set(key, record);
            return record;
        }),
        head: vi.fn(async (key: string) => objects.get(key) ?? null),
        get: vi.fn(async (key: string) => {
            const object = objects.get(key);
            return object ? { ...object, body: new Response(new Uint8Array(object.bytes)).body } : null;
        }),
    };
    const env = {
        DB: { prepare }, PRIVATE_MEDIA: bucket, JWT_SECRET: secret,
        RIN_GITHUB_CLIENT_ID: 'fixture-client', RIN_GITHUB_CLIENT_SECRET: 'fixture-secret',
        FRONTEND_URL: origin, S3_ACCESS_HOST: 'https://public.invalid', S3_REGION: 'auto',
    } as unknown as Env;
    const token = (id: number, lifetime = '1h') => new SignJWT({ id }).setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime(lifetime).sign(new TextEncoder().encode(secret));
    const call = (options: { token?: string; path?: string; method?: string; body?: BodyInit; env?: Env; origin?: string } = {}) => {
        const headers = new Headers({ Origin: options.origin ?? origin });
        if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
        if (options.body) headers.set('Content-Type', 'application/octet-stream');
        if (options.method === 'OPTIONS') {
            headers.set('Access-Control-Request-Method', 'PUT');
            headers.set('Access-Control-Request-Headers', 'authorization, content-type');
        }
        const init: RequestInit & { duplex?: 'half' } = { method: options.method, body: options.body, headers };
        if (options.body instanceof ReadableStream) init.duplex = 'half';
        return worker.fetch(new Request(`https://worker.invalid/storage/private/${options.path ?? id}`, init), options.env ?? env);
    };
    return { users, feeds, bucket, objects, env, token, call };
}

describe('isolated private media Worker integration', () => {
    it('enforces current authentication, object ownership, no-store and exact CORS', async () => {
        const f = fixture();
        const [owner, other, member, expired] = await Promise.all([f.token(1), f.token(2), f.token(3), f.token(1, '-1m')]);
        for (const token of [undefined, member, expired]) {
            const response = await f.call({ token });
            expect(response.status).toBe(401);
            expect(response.headers.get('cache-control')).toBe('private, no-store');
        }
        expect(f.bucket.get).not.toHaveBeenCalled();
        expect((await f.call({ token: member, method: 'PUT', body: png })).status).toBe(401);
        expect(f.bucket.put).not.toHaveBeenCalled();
        expect((await f.call({ token: owner, path: `%37${id.slice(1)}` })).status).toBe(404);
        expect(f.bucket.get).not.toHaveBeenCalled();
        const preflight = await f.call({ method: 'OPTIONS' });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
        expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');
        expect((await f.call({ method: 'OPTIONS', origin: `${origin}.example` })).headers.get('access-control-allow-origin')).toBeNull();
        expect((await f.call({ token: owner, method: 'PUT', body: png })).status).toBe(201);
        const own = await f.call({ token: owner });
        expect(own.status).toBe(200);
        expect(own.headers.get('content-type')).toBe('image/png');
        expect(own.headers.get('x-content-type-options')).toBe('nosniff');
        expect(own.headers.get('cache-control')).toBe('private, no-store');
        expect(own.headers.get('access-control-allow-origin')).toBe(origin);
        expect(new Uint8Array(await own.arrayBuffer())).toEqual(png);
        expect((await f.call({ token: other, path: `${id}?owner=1` })).status).toBe(404);
        expect(f.bucket.get).toHaveBeenLastCalledWith(`owner/2/${id}`);
        f.users.set(1, 0);
        f.bucket.get.mockClear();
        expect((await f.call({ token: owner })).status).toBe(401);
        expect(f.bucket.get).not.toHaveBeenCalled();
    });

    it('keeps conditional retries immutable and stops bad inputs before storage', async () => {
        const f = fixture();
        const owner = await f.token(1);
        const put = (body: BodyInit, env?: Env) => f.call({ token: owner, method: 'PUT', body, env });
        expect((await put(png, { ...f.env, PRIVATE_MEDIA: undefined })).status).toBe(404);
        expect((await put('<svg/>')).status).toBe(415);
        const large = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1)); controller.close(); } });
        expect((await put(large)).status).toBe(413);
        expect(f.bucket.put).not.toHaveBeenCalled();
        const first = await Promise.all([put(png), put(png)]);
        expect(first.map(result => result.status).sort()).toEqual([200, 201]);
        expect((await put(Uint8Array.of(...png, 0))).status).toBe(409);
        expect([...f.objects.keys()]).toEqual([`owner/1/${id}`]);
        expect(f.objects.get(`owner/1/${id}`)?.bytes).toEqual(png);
    });

    it('uses the authorized current draft to resolve attachments for other users', async () => {
        const f = fixture();
        const [admin, author] = await Promise.all([f.token(1), f.token(2)]);
        expect((await f.call({ token: author, method: 'PUT', body: png })).status).toBe(201);
        const path = `${id}?feedId=7`;
        const content = `![private image](private-media:${id})`;
        f.feeds.set(7, { uid: 2, draft: 1, kind: 'article', content });
        const bound = await f.call({ token: admin, path });
        expect(bound.status).toBe(200);
        expect(new Uint8Array(await bound.arrayBuffer())).toEqual(png);
        expect(f.bucket.get).toHaveBeenLastCalledWith(`owner/2/${id}`);
        expect((await f.call({ token: admin })).status).toBe(404);
        f.bucket.get.mockClear();
        expect((await f.call({ token: admin, path: `${path}&feedId=9` })).status).toBe(404);
        f.users.set(1, 2);
        expect((await f.call({ token: admin, path })).status).toBe(404);
        f.users.set(1, 1);
        f.feeds.set(7, { uid: 2, draft: 0, kind: 'article', content });
        expect((await f.call({ token: admin, path })).status).toBe(404);
        f.feeds.set(7, { uid: 2, draft: 1, kind: 'article', content: `[ordinary link](private-media:${id})` });
        expect((await f.call({ token: admin, path })).status).toBe(404);
        f.feeds.delete(7);
        expect((await f.call({ token: admin, path })).status).toBe(404);
        f.feeds.set(7, { uid: 1, draft: 0, kind: 'memo', content });
        expect((await f.call({ token: admin, path })).status).toBe(404);
        expect(f.bucket.get.mock.calls).toEqual([[`owner/1/${id}`]]);
    });
});
