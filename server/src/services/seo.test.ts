import {it,expect,vi,afterEach} from 'vitest';
import {seoObjectUrl,SEOService} from './seo';
import {runRequestContext} from '../utils/di';
afterEach(()=>vi.unstubAllGlobals());
it('keeps SEO keys in the cache prefix and rejects traversal, credential queries and private paths',()=>{
  const host='https://assets.invalid';
  expect(seoObjectUrl(host,'cache/','blog/feed/1','?page=2').href).toBe(host+'/cache/blog/feed/1%26page%3D2');
  expect(seoObjectUrl(host,'cache/','','').href).toBe(host+'/cache/index.html');
  for(const path of ['../images/x','%2e%2e/images/x','%252e%252e/images/x','x\\..\\private','life/todos','blog/diary','callback','server.config.json']) {
    expect(()=>seoObjectUrl(host,'cache/',path,'')).toThrow();
  }
  expect(()=>seoObjectUrl(host,'cache/','blog','?token=fixture')).toThrow();
  expect(()=>seoObjectUrl('https://user:pass@assets.invalid','cache/','blog','')).toThrow();
});
it('serves bounded HTML in a sandbox and rejects redirects and non-HTML without following them',async()=>{
  const service=runRequestContext({S3_ACCESS_HOST:'https://assets.invalid',S3_CACHE_FOLDER:'cache/'} as any,{} as any,()=>SEOService());
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  for(const upstream of [new Response('{}',{headers:{'Content-Type':'application/json'}}),new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}}),new Response('x'.repeat(2*1024*1024+1),{headers:{'Content-Type':'text/html'}})]) {
    fetch.mockResolvedValueOnce(upstream);
    expect((await service.handle(new Request('http://localhost/seo/blog/feed/1'))).status).toBe(502);
  }
  fetch.mockResolvedValueOnce(new Response('<p>snapshot</p>',{headers:{'Content-Type':'text/html; charset=utf-8'}}));
  const response=await service.handle(new Request('http://localhost/seo/blog/feed/1'));
  expect(response.status).toBe(200);expect(await response.text()).toBe('<p>snapshot</p>');
  expect(response.headers.get('content-security-policy')).toContain('sandbox;');
  expect(response.headers.get('content-security-policy')).not.toContain('allow-scripts');
  expect(fetch.mock.calls.every(([,init])=>init.redirect==='manual' && init.signal instanceof AbortSignal)).toBe(true);
  fetch.mockClear();
  expect((await service.handle(new Request('http://localhost/seo/life/todos'))).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
});
