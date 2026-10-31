import {describe,it,expect,vi,afterEach} from 'vitest';
vi.mock('typescript-cookie',()=>({getCookie:()=>`x.${btoa(JSON.stringify({id:1}))}.x`}));
import {setCached,enqueueMutation} from './local-first';
afterEach(()=>vi.unstubAllGlobals());
describe('IndexedDB durability acknowledgement',()=>{
  it('preserves an explicitly captured queue owner after identity changes and keeps default callers compatible',async()=>{
    const rows:any[]=[];
    const db={close:vi.fn(),transaction:()=>{
      const tx:any={objectStore:()=>({add:(row:unknown)=>{
        rows.push(row);const request:any={result:rows.length};
        queueMicrotask(()=>{request.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.());});return request;
      }})};return tx;
    }};
    vi.stubGlobal('indexedDB',{open:()=>{const request:any={result:db};queueMicrotask(()=>request.onsuccess?.());return request;}});
    vi.stubGlobal('window',{dispatchEvent:vi.fn()});
    vi.stubGlobal('CustomEvent',class extends Event {});
    const payload={content:'original',clientKey:'stable-key'};
    await enqueueMutation('habit','create',payload,7);
    await enqueueMutation('todo','create',payload);
    expect(rows[0]).toMatchObject({ownerId:7,payload,action:'create',status:'pending'});
    expect(rows[1]).toMatchObject({ownerId:1,payload});
    await expect(enqueueMutation('todo','create',payload,0)).rejects.toThrow();
    expect(rows).toHaveLength(2);
  });
  it('waits for transaction commit and rejects abort after request success',async()=>{
    const write:any={result:undefined},tx:any={objectStore:()=>({put:()=>{queueMicrotask(()=>write.onsuccess?.());return write;}})},open:any={result:{transaction:()=>tx,close:vi.fn()}};
    vi.stubGlobal('indexedDB',{open:()=>{queueMicrotask(()=>open.onsuccess());return open;}});
    let acknowledged=false;const promise=setCached('life:sample',{content:'local'}).then(()=>{acknowledged=true;});
    await new Promise(resolve=>setTimeout(resolve,0));expect(acknowledged).toBe(false);
    tx.error=new Error('transaction aborted');tx.onabort();await expect(promise).rejects.toThrow('transaction aborted');
    expect(acknowledged).toBe(false);
  });
});
