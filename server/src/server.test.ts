import 'reflect-metadata';
import {SignJWT} from 'jose';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {treaty} from '@elysiajs/eden';
import {app} from './server';
import worker from './_worker';
import {runRequestContext} from './utils/di';
import {limitRequestBody} from './utils/request-body';

const env={JWT_SECRET:'test-only-jwt-secret-at-least-32-characters',RIN_GITHUB_CLIENT_ID:'test-client',RIN_GITHUB_CLIENT_SECRET:'test-secret',FRONTEND_URL:'https://site.invalid',S3_ACCESS_HOST:'https://assets.invalid',S3_CACHE_FOLDER:'cache/',S3_REGION:'auto'} as any;
const user={id:1,username:'test-owner',permission:1,role:'owner',avatar:'',createdAt:new Date(),updatedAt:new Date()};
const db={query:{users:{findFirst:async()=>user}}} as any;
const make=()=>runRequestContext(env,db,()=>app());
const call=(service:ReturnType<typeof app>,request:Request)=>runRequestContext(env,db,()=>service.handle(request));

afterEach(()=>vi.unstubAllGlobals());
describe('framework upgrade compatibility and security boundary',()=>{
  it('retains private-route guards and authorizes before upload parsing',async()=>{
    const service=make();
    for(const path of ['/life/todos','/life/backup','/user/profile']) {
      const response=await call(service,new Request('http://localhost'+path));
      expect(response.status,path).toBe(403);
    }
    expect((await call(service,new Request('http://localhost/config/server'))).status).toBe(401);
    const upload=await call(service,new Request('http://localhost/storage',{method:'POST',headers:{'content-type':'application/json'},body:'{'}));
    expect(upload.status).toBe(401);
  });
  it('serves precise CORS and keeps existing tokens and Eden profile calls usable',async()=>{
    const service=make();
    const token=await new SignJWT({id:1}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));
    const fetcher:typeof fetch=Object.assign((input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>call(service,new Request(input,init)),{preconnect:()=>{}});
    const api=treaty<ReturnType<typeof app>>('http://localhost',{fetcher});
    const profile=await api.user.profile.get({headers:{Authorization:'Bearer '+token}});
    expect(profile.status).toBe(200);expect(profile.data).toMatchObject({id:1,role:'owner'});
    for(const origin of ['https://site.invalid','https://site.invalid.evil.invalid']) {
      const response=await call(service,new Request('http://localhost/life/todos',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET'}}));
      expect(response.headers.get('access-control-allow-origin')).toBe(origin==='https://site.invalid'?origin:null);
    }
  });
  it('prevents caching at the Worker boundary for private successes, denials and configuration failures',async()=>{
    // Simulate only the configuration row lookup. Anonymous route guards must
    // return before any private content is queried.
    const prepare = vi.fn((sql: string) => {
      if (sql.includes('"info"')) return { bind: () => ({ raw: async () => [['private:server.config:v1','{}']] }) };
      if (sql.includes('"users"')) return { bind: () => ({ raw: async () => [[1,'test-owner','owner','',1,null,0,0]] }) };
      throw Error('Unexpected D1 query');
    });
    const workerEnv = { ...env, DB: { prepare } };
    for (const [path,status] of [
      ['/life/todos',403], ['/habit',403], ['/rss/storage',403], ['/feed?type=draft',403],
      ['/tag/options?scope=diary',403], ['/tag?kind=memo',200], ['/config/server',401],
      ['/life/backup?version=5',403], ['/life/reports/mail',403], ['/life/todo-capabilities',200],
    ] as const) {
      const response = await worker.fetch(new Request('http://localhost'+path),workerEnv);
      expect(response.status,path).toBe(status);
      expect(response.headers.get('cache-control'),path).toMatch(/private.*no-store/);
    }
    const publicResponse = await worker.fetch(new Request('http://localhost/reliability/capabilities'),workerEnv);
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get('cache-control')).toBeNull();
    const token = await new SignJWT({id:1}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));
    const profile = await worker.fetch(new Request('http://localhost/user/profile',{
      headers: { Authorization: 'Bearer '+token },
    }),workerEnv);
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({id:1,role:'owner'});
    expect(profile.headers.get('cache-control')).toBe('private, no-store');
    const redirect = await worker.fetch(new Request('http://localhost/user/github'),workerEnv);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(redirect.headers.get('cache-control')).toBe('private, no-store');

    const unavailable = await worker.fetch(new Request('http://localhost/life/todos',{
      headers: { Origin: env.FRONTEND_URL },
    }),{ ...env, DB: { prepare: () => { throw Error('Configuration unavailable'); } } });
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('retry-after')).toBe('60');
    expect(unavailable.headers.get('access-control-allow-origin')).toBe(env.FRONTEND_URL);
    expect(unavailable.headers.get('cache-control')).toBe('private, no-store');
  });
  it('rejects oversized streamed JSON without a content-length header',async()=>{
    const service=make();
    const token=await new SignJWT({id:1}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));
    const request=new Request('http://localhost/life/notes/2026-10-30',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({content:'x'.repeat(100),updatedAt:new Date().toISOString()})});
    const response=await call(service,limitRequestBody(request,32));
    expect(response.status,await response.text()).toBe(413);
  });
  it('bounds Life date queries before content reads and accepts legacy local-time windows',async()=>{
    const findMany = vi.fn(async () => []);
    const lifeDb = {
      query: {
        users: db.query.users,
        habits: { findMany }, habitLogs: { findMany }, pomodoroSessions: { findMany },
        rssItems: { findMany }, dailyBasics: { findMany }, lifeDailyNotes: { findMany }, lifeTodos: { findMany },
      },
      select: () => ({ from: () => ({ where: async () => [{ value: 0 }] }) }),
    } as any;
    const service = runRequestContext(env, lifeDb, () => app());
    const token = await new SignJWT({id:1}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));
    const get = (path: string, query: Record<string, string>) => runRequestContext(env, lifeDb, () => service.handle(new Request(
      `http://localhost${path}?${new URLSearchParams(query)}`, { headers: { Authorization: `Bearer ${token}` } },
    )));
    // A west-coast DST day can run for 25 hours and overlap the next Shanghai date.
    const overview = { day:'2026-11-02', dayStart:'2026-11-01T07:00:00Z', dayEnd:'2026-11-02T08:00:00Z', weekStart:'2026-10-26', weekEnd:'2026-11-01' };
    const month = { month:'2024-02', start:'2024-01-31T16:00:00Z', end:'2024-02-29T16:00:00Z' };
    const year = { year:'2024', start:'2023-12-31T16:00:00Z', end:'2024-12-31T16:00:00Z' };
    const leapDay = { from:'2024-02-29', to:'2024-02-29' };
    for (const [path, query] of [
      ['/life/overview', { ...overview, dayEnd:'2027-11-02T08:00:00Z' }],
      ['/life/overview', { ...overview, weekStart:'2000-01-01' }],
      ['/life/overview', { ...overview, day:'2026-02-29' }],
      ['/life/overview', { ...overview, dayStart:'2026-02-30T07:00:00Z' }],
      ['/life/calendar', { ...month, month:'2024-13' }],
      ['/life/calendar', { ...month, end:year.end }],
      ['/life/year', { ...year, year:'2025' }],
      ['/life/notes', { ...leapDay, to:'2030-02-28' }],
      ['/life/basics', { ...leapDay, to:'2024-02-28' }],
      ['/habit/range', { from:'2025-02-29', to:'2025-03-01' }],
    ] as const) expect((await get(path, query)).status, path).toBe(400);
    expect((await get('/habit/calendar', { month:'2026-13' })).status).toBe(422);
    expect(findMany).not.toHaveBeenCalled();

    for (const [path, query] of [
      ['/life/overview', overview], ['/life/calendar', month], ['/life/year', year],
      ['/life/basics', leapDay], ['/life/notes', { from:'2024-02-26', to:'2024-03-03' }],
      ['/habit/range', leapDay], ['/habit/calendar', { month:'2024-02' }],
    ] as const) expect((await get(path, query)).status, path).toBe(200);
    expect(findMany).toHaveBeenCalled();
  });
  it('does not expose internal database diagnostics in a failed request',async()=>{
    const broken={query:{users:{findFirst:async()=>{throw Error('fixture private database diagnostic');}}}} as any;
    const service=runRequestContext(env,broken,()=>app());
    const token=await new SignJWT({id:1}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));
    const response=await runRequestContext(env,broken,()=>service.handle(new Request('http://localhost/user/profile',{headers:{authorization:'Bearer '+token}})));
    expect(response.status).toBe(500);expect(await response.text()).not.toContain('private database diagnostic');
  });
  it('returns a structured pause when the database driver wraps a daily quota failure',async()=>{
    const broken={query:{users:{findFirst:async()=>{throw new Error('Failed query with private parameters',{cause:new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit.")});}}}} as any;
    const service=runRequestContext(env,broken,()=>app());
    const token=await new SignJWT({id:1}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));
    const response=await runRequestContext(env,broken,()=>service.handle(new Request('http://localhost/user/profile',{headers:{authorization:'Bearer '+token}})));
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
    const text=await response.text();expect(text).toContain('D1_QUOTA_PAUSED');expect(text).not.toContain('private parameters');
  });
  it('preserves GitHub OAuth redirect/state cookies and rejects mismatched callbacks before token exchange',async()=>{
    const service=make();
    const response=await call(service,new Request('https://worker.invalid/user/github'));
    expect(response.status).toBe(302);
    const location=new URL(response.headers.get('location')!);
    expect(location.origin).toBe('https://github.com');expect(location.searchParams.get('scope')).toBe('read:user');
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(response.headers.get('set-cookie')).toMatch(/Secure/i);
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    const bad=await call(service,new Request('https://worker.invalid/user/github/callback?state=wrong&code=test-code'));
    expect(bad.status).not.toBe(200);expect(fetch).not.toHaveBeenCalled();
  });
});
