import {createHmac} from 'node:crypto';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {subscribeWebSub,verifyWebsub,websubSecret} from './websub';
import {runRequestContext} from '../../utils/di';

afterEach(()=>vi.unstubAllGlobals());
describe('signed WebSub leases',()=>{
  it('verifies raw payloads for both supported hub signature algorithms',async()=>{
    const body=new TextEncoder().encode('<feed>原文</feed>'),secret='test-only-secret';
    for(const algorithm of ['sha1','sha256']) {
      const signature=algorithm+'='+createHmac(algorithm,secret).update(body).digest('hex');
      expect(await verifyWebsub(body,signature,secret)).toBe(true);
      expect(await verifyWebsub(new TextEncoder().encode('<feed>修改</feed>'),signature,secret)).toBe(false);
      expect(await verifyWebsub(body,signature,'other')).toBe(false);
    }
    expect(await verifyWebsub(body,null,secret)).toBe(false);
    expect(await verifyWebsub(body,'sha256=00',secret)).toBe(false);
    expect(await verifyWebsub(body,'md5='+'a'.repeat(32),secret)).toBe(false);
  });
  it('derives separate subscription secrets without exposing the JWT signing key',async()=>{
    const a=await websubSecret(1,'v2_test','test-only-jwt');
    expect(a).toBe(createHmac('sha256','test-only-jwt').update('websub/v2:1:v2_test').digest('hex'));
    expect(await websubSecret(2,'v2_test','test-only-jwt')).not.toBe(a);
  });
  it('upgrades old callbacks before hub verification and invalidates the old lease',async()=>{
    let update:any;const db={update:()=>({set:(value:any)=>{update=value;return {where:async()=>{}};}})} as any;
    vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{
      expect(update.websubKey).toMatch(/^v2_/);
      expect(update.websubLeaseExpiresAt).toBeNull();
      const form=init.body as URLSearchParams;
      expect(form.get('hub.callback')).toBe(update.websubCallback);
      expect(form.get('hub.secret')).toBe(await websubSecret(1,update.websubKey,'test-only-jwt'));
      return new Response(null,{status:202});
    }));
    const raw={prepare:()=>({bind:()=>({all:async()=>({results:[{reserved:8}]})})})};
    await runRequestContext({DB:raw,JWT_SECRET:'test-only-jwt'} as any,db,()=>subscribeWebSub(db,{id:1,websubKey:'old',websubCallback:'https://api.invalid/rss/websub/1/old',feedUrl:'https://www.youtube.com/feeds/videos.xml?channel_id=test',websubLeaseExpiresAt:new Date(Date.now()+9*86400000)} as any));
    expect(update.websubCallback).toBe(`https://api.invalid/rss/websub/1/${update.websubKey}`);
  });
});
