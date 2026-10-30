import 'reflect-metadata';
import {SignJWT} from 'jose';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {treaty} from '@elysiajs/eden';
import {app} from './server';
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
    expect(profile.response.headers.get('cache-control')).toContain('no-store');
    for(const origin of ['https://site.invalid','https://site.invalid.evil.invalid']) {
      const response=await call(service,new Request('http://localhost/life/todos',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET'}}));
      expect(response.headers.get('access-control-allow-origin')).toBe(origin==='https://site.invalid'?origin:null);
    }
  });
  it('rejects oversized streamed JSON without a content-length header',async()=>{
    const service=make();
    const token=await new SignJWT({id:1}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));
    const request=new Request('http://localhost/life/notes/2026-10-30',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({content:'x'.repeat(100),updatedAt:new Date().toISOString()})});
    const response=await call(service,limitRequestBody(request,32));
    expect(response.status,await response.text()).toBe(413);
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
