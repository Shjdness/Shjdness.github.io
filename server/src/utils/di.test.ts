import {describe,it,expect,vi} from 'vitest';
import {runRequestContext,getDB,getEnv} from './di';
vi.mock('./s3',()=>({createS3Client:()=>({send:vi.fn()})}));
import {PublicCache} from './cache';
describe('request context isolation',()=>{
  it('keeps interleaved request bindings and public caches separate',async()=>{
    const envA={S3_ACCESS_HOST:'https://a.invalid',S3_CACHE_FOLDER:'cache'} as any;
    const envB={S3_ACCESS_HOST:'https://b.invalid',S3_CACHE_FOLDER:'cache'} as any;
    const a={} as any,b={} as any;let release!:()=>void;
    const wait=new Promise<void>(resolve=>{release=resolve;});
    const first=runRequestContext(envA,a,async()=>{
      await PublicCache().set('test','a');await wait;
      expect(getEnv()).toBe(envA);expect(getDB()).toBe(a);
      expect(await PublicCache().get('test')).toBe('a');
    });
    await runRequestContext(envB,b,async()=>{
      await PublicCache().set('test','b');release();await first;
      expect(getEnv()).toBe(envB);expect(getDB()).toBe(b);
      expect(await PublicCache().get('test')).toBe('b');
    });
  });
});
