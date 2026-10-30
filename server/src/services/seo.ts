import Elysia from 'elysia';
import { getEnv } from '../utils/di';
import { readLimitedBody } from '../utils/request-body';

/** Build a single object URL; user paths cannot escape the configured cache. */
export function seoObjectUrl(host:string,folder:string,path:string,search:string) {
  const base=new URL(host);
  if(base.protocol!=='https:' || base.username || base.password || base.search || base.hash)throw Error('Invalid SEO origin');
  let decoded:string;
  try{decoded=decodeURIComponent(path);}catch{throw Error('Invalid SEO path');}
  if(decoded.length>1024 || /[%\\\u0000-\u001f\u007f?#]/.test(decoded))throw Error('Invalid SEO path');
  const parts=decoded.split('/');
  if(parts.some(part=>part==='.'||part==='..'))throw Error('Invalid SEO path');
  const route=parts.filter(Boolean).join('/');
  if(/\.(?:json|sql|toml|ya?ml|env)$/i.test(route))throw Error('Non-HTML SEO path');
  if(/^(?:life|callback|writing|appearance)(?:\/|$)|^blog\/(?:diary|memos|drafts|writing)(?:\/|$)/i.test(route))throw Error('Private SEO path');
  const prefix=folder.split('/').filter(Boolean);
  if(!prefix.length || prefix.some(part=>part==='.'||part==='..'||/[\\%?#]/.test(part)))throw Error('Invalid SEO folder');
  const query=new URLSearchParams(search);
  if([...query.keys()].some(key=>/token|authorization|secret|password|^code$|^state$/i.test(key)))throw Error('Invalid SEO query');
  // Keep the existing snapshot writer's path&query object-key convention.
  let key=decoded.replace(/^\/+/, '');
  if(query.size)key+='&'+query.toString();
  if(!key || key.endsWith('/'))key+='index.html';
  base.pathname=base.pathname.replace(/\/$/,'')+'/'+[...prefix,...key.split('/')].map(encodeURIComponent).join('/');
  return base;
}

const headers={
  'Content-Type':'text/html; charset=utf-8',
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'Cache-Control':'public, max-age=60',
  'Content-Security-Policy':"sandbox; default-src 'none'; img-src https: data:; style-src https: 'unsafe-inline'; font-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function SEOService() {
  const env=getEnv();
  return new Elysia({aot:false}).get('/seo/*',async({params,request})=>{
    let target:URL;
    try{target=seoObjectUrl(env.S3_ACCESS_HOST||env.S3_ENDPOINT,env.S3_CACHE_FOLDER||'cache/',params['*'],new URL(request.url).search);}
    catch{return new Response('Snapshot not found',{status:404});}
    try {
      const response=await fetch(target,{redirect:'manual',signal:AbortSignal.timeout(10000)});
      if(response.status===404){await response.body?.cancel();return new Response('Snapshot not found',{status:404});}
      if(!response.ok || !/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type')||'')) {
        await response.body?.cancel();return new Response('Snapshot unavailable',{status:502});
      }
      const bytes=await readLimitedBody(new Request('https://snapshot.invalid',{method:'POST',body:response.body,duplex:'half'} as RequestInit),2*1024*1024);
      return new Response(bytes,{headers});
    } catch {return new Response('Snapshot unavailable',{status:502});}
  });
}
