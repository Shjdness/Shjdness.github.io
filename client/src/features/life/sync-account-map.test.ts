import { expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({owner:1,read:vi.fn(),write:vi.fn(),writtenOwners:[] as number[]}));
vi.mock('typescript-cookie',()=>({getCookie:()=>`x.${btoa(JSON.stringify({id:state.owner}))}.x`}));
vi.mock('./model',()=>({lifeApi:vi.fn()}));
vi.mock('../../data/local-first',async importOriginal=>({
  ...await importOriginal<typeof import('../../data/local-first')>(),
  getCached:(...args:unknown[])=>state.read(...args),
  setCached:(...args:unknown[])=>{state.writtenOwners.push(state.owner);return state.write(...args);},
}));
import {lifeApi} from './model';
import {processSyncQueue,type SyncItem} from '../../data/local-first';
import {sendQueuedMutation} from './sync';
const entities=['habit','basic','todo'] as const;
const item=(entity:typeof entities[number]):SyncItem=>({id:1,ownerId:1,entity,action:'create',payload:{localId:-7,name:'fixture',content:'fixture',date:'2026-10-31',clientKey:'original-operation'},createdAt:1,retryCount:0,status:'pending'});
function setup() {
  state.owner=1;state.writtenOwners=[];
  state.read.mockReset().mockResolvedValue({value:{}});state.write.mockReset().mockResolvedValue(undefined);
  vi.mocked(lifeApi).mockReset().mockResolvedValue({insertedId:101});
  return {markSyncing:vi.fn(async()=>undefined),remove:vi.fn(async()=>undefined),markFailed:vi.fn(async()=>undefined)};
}
function pending() {let resolve!:(value?:unknown)=>void;const promise=new Promise<unknown>(yes=>{resolve=yes;});return {promise,resolve};}

it('does not put an old account ID map into a new account after an asynchronous cache read',async()=>{
  for(const entity of entities) {
    const storage=setup(),read=pending(),entry=item(entity);
    state.read.mockReturnValue(read.promise);
    const result=processSyncQueue([entry],true,sendQueuedMutation,storage);
    await vi.waitFor(()=>expect(state.read).toHaveBeenCalledOnce());
    state.owner=2;read.resolve({value:{}});
    await result;
    expect(state.write).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(storage.markFailed).toHaveBeenCalledWith(expect.objectContaining({ownerId:1,payload:entry.payload}),expect.stringContaining('账号已切换'));
  }
});

it('retains the original operation if the account changes while its mapping write commits',async()=>{
  for(const entity of entities) {
    const storage=setup(),write=pending();state.write.mockReturnValue(write.promise);
    const result=processSyncQueue([item(entity)],true,sendQueuedMutation,storage);
    await vi.waitFor(()=>expect(state.write).toHaveBeenCalledOnce());
    state.owner=2;write.resolve();await result;
    expect(state.writtenOwners).toEqual([1]);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(storage.markFailed).toHaveBeenCalledOnce();
  }
});

it('still acknowledges all three creation types after a mapping commit in the original account',async()=>{
  for(const entity of entities) {
    const storage=setup();
    await processSyncQueue([item(entity)],true,sendQueuedMutation,storage);
    expect(state.write).toHaveBeenCalledWith(`life:${entity}-id-map`,{'-7':101});
    expect(state.writtenOwners).toEqual([1]);
    expect(storage.remove).toHaveBeenCalledWith(1);
    expect(storage.markFailed).not.toHaveBeenCalled();
  }
});

it('preserves the original request key and payload when mapping storage fails and the operation retries',async()=>{
  const storage=setup(),entry=item('todo');
  state.write.mockRejectedValueOnce(new Error('storage failed'));
  await processSyncQueue([entry],true,sendQueuedMutation,storage);
  expect(storage.remove).not.toHaveBeenCalled();
  await processSyncQueue([entry],true,sendQueuedMutation,storage);
  const calls=vi.mocked(lifeApi).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0][1]?.body).toBe(calls[1][1]?.body);
  expect(String(calls[1][1]?.body)).toContain('original-operation');
  expect(storage.remove).toHaveBeenCalledOnce();
});
