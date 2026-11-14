import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import worker from '../_worker';
import type { Env } from '../db/db';
import { githubSubject } from '../utils/github-subject';
import { privateMediaKey } from '../utils/private-media-reference';
import { readLimitedBody } from '../utils/request-body';

vi.mock('../utils/request-body', async (importOriginal) => {
    const module = await importOriginal<typeof import('../utils/request-body')>();
    return { ...module, readLimitedBody: vi.fn(module.readLimitedBody) };
});

const id = '784f0bfa-6d25-4a21-9f5c-f410fdb7822a';
const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const origin = 'https://site.invalid';
const secret = 'isolated-jwt-secret-at-least-32-characters';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const budgetMigration = readFileSync(new URL('../../sql/0044-private-media-budget.sql', import.meta.url), 'utf8');
const day = () => new Date().toISOString().slice(0, 10);

function fixture() {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(budgetMigration);
    const reserve = vi.fn((sql: string, params: Array<string | number>) => sqlite.prepare(sql).all(...params));
    const users = new Map([[1, 1], [2, 2], [3, 0]]);
    const openids = new Map([[1, '101'], [2, '102.0'], [3, '103']]);
    const feeds = new Map<number, { uid: number; draft: number; kind: string; content: string }>();
    const prepare = vi.fn((sql: string) => ({ bind: (id: number, ...params: Array<string | number>) => ({
        all: async () => ({ results: reserve(sql, [id, ...params]) }),
        raw: async () => {
        if (sql.includes('"info"')) return [['private:server.config:v1', '{}']];
        if (sql.includes('"feeds"')) {
            // Drizzle binds the nested user limit before the outer feed ID.
            const feed = feeds.get(Number(params[0]));
            return feed ? [[feed.uid, feed.draft, feed.kind, feed.content, JSON.stringify([openids.get(feed.uid)])]] : [];
        }
        if (!sql.includes('"users"')) throw Error('Unexpected database read');
        const role = users.get(id);
        return role === undefined ? [] : [[id, 'fixture', openids.get(id), '', role, null, 0, 0]];
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
        DB: { prepare }, PRIVATE_MEDIA: bucket, PRIVATE_MEDIA_WRITES_PAUSED: 'false', JWT_SECRET: secret,
        RIN_GITHUB_CLIENT_ID: 'fixture-client', RIN_GITHUB_CLIENT_SECRET: 'fixture-secret',
        FRONTEND_URL: origin, S3_ACCESS_HOST: 'https://public.invalid', S3_REGION: 'auto',
    } as unknown as Env;
    const token = async (id: number, lifetime = '1h', bound = true) => {
        const sub = bound ? await githubSubject(id, openids.get(id)) : undefined;
        return new SignJWT({ id, sub }).setProtectedHeader({ alg: 'HS256' })
            .setExpirationTime(lifetime).sign(new TextEncoder().encode(secret));
    };
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
    const key = async (uid: number) => privateMediaKey((await githubSubject(uid, openids.get(uid)))!, id);
    return { users, openids, feeds, bucket, objects, env, token, call, reserve, sqlite, key };
}

describe('isolated private media Worker integration', () => {
    it('fails closed unless writes explicitly enabled and leaves reads available during recovery', async () => {
        const f = fixture();
        const owner = await f.token(1);
        expect((await f.call({ token: owner, method: 'PUT', body: png })).status).toBe(201);
        const snapshots = f.reserve.mock.calls.length;
        f.bucket.head.mockClear();
        f.bucket.put.mockClear();
        vi.mocked(readLimitedBody).mockClear();
        for (const value of [undefined, 'true', 'invalid']) {
            const env = { ...f.env, PRIVATE_MEDIA_WRITES_PAUSED: value };
            const denied = await f.call({ env, token: owner, method: 'PUT', body: png });
            expect(denied.status).toBe(503);
            expect(denied.headers.get('cache-control')).toBe('private, no-store');
            expect(await denied.json()).toMatchObject({ code: 'PRIVATE_MEDIA_WRITES_PAUSED' });
            expect((await f.call({ env, token: owner })).status).toBe(200);
        }
        expect(f.reserve).toHaveBeenCalledTimes(snapshots);
        expect(readLimitedBody).not.toHaveBeenCalled();
        expect(f.bucket.head).not.toHaveBeenCalled();
        expect(f.bucket.put).not.toHaveBeenCalled();
    });

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
        expect(f.bucket.get).toHaveBeenLastCalledWith(await f.key(2));
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
        expect([...f.objects.keys()]).toEqual([await f.key(1)]);
        expect(f.objects.get(await f.key(1))?.bytes).toEqual(png);
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
        expect(f.bucket.get).toHaveBeenLastCalledWith(await f.key(2));
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
        expect(f.bucket.get.mock.calls).toEqual([[await f.key(1)]]);
    });

    it('rejects legacy media sessions, shared guests and numeric owner reuse while preserving the GitHub identity', async () => {
        const f = fixture();
        const original = await f.token(2);
        expect((await f.call({ token: original, method: 'PUT', body: png })).status).toBe(201);
        f.openids.set(2, '102');
        expect((await f.call({ token: original })).status).toBe(200);
        f.openids.set(2, '3102');
        const replacement = await f.token(2);
        const legacy = await f.token(2, '1h', false);
        const boundPath = `${id}?feedId=7`;
        f.feeds.set(7, { uid: 2, draft: 1, kind: 'article', content: `![](private-media:${id})` });
        for (const path of [id, boundPath]) {
            expect((await f.call({ token: original, path })).status).toBe(401);
            expect((await f.call({ token: legacy, path })).status).toBe(403);
            expect((await f.call({ token: replacement, path })).status).toBe(404);
        }
        f.openids.set(3, 'guest:fixture');
        f.users.set(3, 2);
        const guest = await f.token(3);
        expect((await f.call({ token: guest, method: 'PUT', body: png })).status).toBe(403);
        expect(f.objects.size).toBe(1);
    });

    it('admits both limits atomically and leaves exhausted accounts able to confirm old uploads', async () => {
        const f = fixture();
        const [owner, other] = await Promise.all([f.token(1), f.token(2)]);
        const put = (token = owner, path = id, body = png) => f.call({ token, path, method: 'PUT', body });
        const insert = f.sqlite.prepare('INSERT INTO private_media_budget VALUES (?, ?, ?, ?)');
        insert.run(day(), 'site', 198, 128 * 1024 * 1024 - 2 * png.length);
        insert.run(day(), 'owner:1', 39, 32 * 1024 * 1024 - png.length);
        const otherId = `a${id.slice(1)}`;
        const thirdId = `b${id.slice(1)}`;
        const competing = await Promise.all([put(owner, id), put(owner, otherId)]);
        expect(competing.map(result => result.status).sort()).toEqual([201, 429]);
        expect(f.bucket.put).toHaveBeenCalledTimes(1);
        const winner = competing[0].status === 201 ? id : otherId;
        expect((await put(owner, winner)).status).toBe(200);
        expect((await put(owner, winner, Uint8Array.of(...png, 0))).status).toBe(409);
        expect(f.reserve).toHaveBeenCalledTimes(2);
        expect((await put(other, thirdId)).status).toBe(201);
        const rejected = await put(other, otherId);
        expect(rejected.status).toBe(429);
        expect(rejected.headers.get('cache-control')).toBe('private, no-store');
        expect(Number(rejected.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(await rejected.json()).toEqual({ code: 'PRIVATE_MEDIA_DAILY_LIMIT' });
        expect(f.bucket.put).toHaveBeenCalledTimes(2);
        expect(f.sqlite.prepare('SELECT scope, attempts FROM private_media_budget ORDER BY scope').all())
            .toEqual([{ scope: 'owner:1', attempts: 40 }, { scope: 'owner:2', attempts: 1 }, { scope: 'site', attempts: 200 }]);
    });

    it('fails closed on an unknown budget result and recognizes a committed R2 upload after UTC rollover', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(new Date('2026-11-14T23:59:59Z'));
            const f = fixture();
            const owner = await f.token(1, '24h');
            const put = (path = id) => f.call({ token: owner, path, method: 'PUT', body: png });
            f.reserve.mockImplementationOnce((sql, params) => {
                f.sqlite.prepare(sql).all(...params);
                throw Error('Synthetic lost D1 receipt');
            });
            expect((await put()).status).toBe(503);
            expect(f.bucket.put).not.toHaveBeenCalled();
            const write = f.bucket.put.getMockImplementation()!;
            f.bucket.put.mockImplementationOnce(async (...params) => {
                await write(...params);
                throw Error('Synthetic lost R2 receipt');
            });
            expect((await put()).status).toBe(503);
            expect(f.objects.size).toBe(1);
            vi.setSystemTime(new Date('2026-11-15T00:00:01Z'));
            expect((await put()).status).toBe(200);
            expect(f.reserve).toHaveBeenCalledTimes(2);
            expect((await put(`c${id.slice(1)}`)).status).toBe(201);
            expect(f.sqlite.prepare("SELECT day, attempts FROM private_media_budget WHERE scope = 'site' ORDER BY day").all())
                .toEqual([{ day: '2026-11-14', attempts: 2 }, { day: '2026-11-15', attempts: 1 }]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects the byte cap without consuming either account or site attempts', async () => {
        const f = fixture();
        const owner = await f.token(1);
        const put = () => f.call({ token: owner, method: 'PUT', body: png });
        const insert = f.sqlite.prepare('INSERT INTO private_media_budget VALUES (?, ?, ?, ?)');
        for (const [scope, limit] of [['site', 128], ['owner:1', 32]] as const) {
            f.sqlite.prepare('DELETE FROM private_media_budget').run();
            insert.run(day(), scope, 1, limit * 1024 * 1024 - png.length + 1);
            const read = f.sqlite.prepare('SELECT * FROM private_media_budget');
            const before = read.all();
            expect((await put()).status).toBe(429);
            expect(read.all()).toEqual(before);
        }
        expect(f.bucket.put).not.toHaveBeenCalled();
    });
});
