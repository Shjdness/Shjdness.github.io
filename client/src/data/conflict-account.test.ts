import {afterEach,expect,it,vi} from 'vitest';
const identity=vi.hoisted(()=>({owner:1}));
vi.mock('typescript-cookie',()=>({getCookie:()=>`x.${btoa(JSON.stringify({id:identity.owner}))}.x`}));
import {resolveSyncConflict,type SyncItem} from './local-first';
const entry:SyncItem={id:11,ownerId:1,entity:'note',action:'save',payload:{date:'2026-10-31',content:'original private fixture'},remote:{revision:1},createdAt:1,retryCount:0,status:'conflict'};
afterEach(()=>{vi.unstubAllGlobals();identity.owner=1;});
function storage() {
  const archives:any[]=[],deleted:number[]=[],transactions:any[]=[];
  const db={close:vi.fn(),transaction:()=>{
    let request:any;
    const tx:any={objectStore:()=>({
      put:(value:unknown)=>{archives.push(value);request={result:11};return request;},
      delete:(id:number)=>{deleted.push(id);request={result:undefined};return request;},
    }),finish:()=>{request.onsuccess?.();tx.oncomplete?.();}};
    transactions.push(tx);return tx;
  }};
  vi.stubGlobal('indexedDB',{open:()=>{const request:any={result:db};queueMicrotask(()=>request.onsuccess?.());return request;}});
  vi.stubGlobal('window',{dispatchEvent:vi.fn()});vi.stubGlobal('CustomEvent',class extends Event {});
  return {archives,deleted,transactions};
}

it('does not send or discard a conflict after account changes while the archive commits',async()=>{
  for(const useLocal of [true,false]) {
    identity.owner=1;const data=storage(),send=vi.fn(async()=>undefined);
    const result=resolveSyncConflict(entry,useLocal,send);
    await vi.waitFor(()=>expect(data.transactions).toHaveLength(1));
    expect(data.archives[0]).toMatchObject({key:'account:1:life:conflict-archive:11',value:entry});
    identity.owner=2;data.transactions[0].finish();
    await expect(result).rejects.toThrow('账号已切换');
    expect(send).not.toHaveBeenCalled();expect(data.deleted).toEqual([]);
  }
});

it('keeps normal resolution and prevents acknowledgement after switching during an original-account send',async()=>{
  for(const switchDuringSend of [false,true]) {
    identity.owner=1;const data=storage(),sentOwners:number[]=[];
    let finish!:()=>void;const pending=new Promise<void>(yes=>{finish=yes;});
    const send=vi.fn(()=>{sentOwners.push(identity.owner);return pending;});
    const result=resolveSyncConflict(entry,true,send);
    await vi.waitFor(()=>expect(data.transactions).toHaveLength(1));data.transactions[0].finish();
    await vi.waitFor(()=>expect(send).toHaveBeenCalledOnce());
    if(switchDuringSend)identity.owner=2;
    finish();
    if(switchDuringSend) {
      await expect(result).rejects.toThrow('账号已切换');expect(data.deleted).toEqual([]);
    } else {
      await vi.waitFor(()=>expect(data.transactions).toHaveLength(2));data.transactions[1].finish();
      await result;expect(data.deleted).toEqual([11]);
    }
    expect(sentOwners).toEqual([1]);
  }
});
