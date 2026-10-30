import {describe,it,expect,vi,afterEach} from 'vitest';
vi.mock('typescript-cookie',()=>({getCookie:()=>`x.${btoa(JSON.stringify({id:1}))}.x`}));
import {setCached} from './local-first';
afterEach(()=>vi.unstubAllGlobals());
describe('IndexedDB durability acknowledgement',()=>{
  it('waits for transaction commit and rejects abort after request success',async()=>{
    const write:any={result:undefined},tx:any={objectStore:()=>({put:()=>{queueMicrotask(()=>write.onsuccess?.());return write;}})},open:any={result:{transaction:()=>tx,close:vi.fn()}};
    vi.stubGlobal('indexedDB',{open:()=>{queueMicrotask(()=>open.onsuccess());return open;}});
    let acknowledged=false;const promise=setCached('life:sample',{content:'local'}).then(()=>{acknowledged=true;});
    await new Promise(resolve=>setTimeout(resolve,0));expect(acknowledged).toBe(false);
    tx.error=new Error('transaction aborted');tx.onabort();await expect(promise).rejects.toThrow('transaction aborted');
    expect(acknowledged).toBe(false);
  });
});
