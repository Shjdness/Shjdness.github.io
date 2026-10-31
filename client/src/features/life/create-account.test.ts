import { expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({owner:1,enqueue:vi.fn(),read:vi.fn(),write:vi.fn(),writtenOwners:[] as number[]}));
vi.mock('typescript-cookie',()=>({getCookie:()=>`x.${btoa(JSON.stringify({id:state.owner}))}.x`}));
vi.mock('../../main',()=>({client:{}}));
vi.mock('./model',()=>({lifeApi:vi.fn()}));
vi.mock('./layout',()=>({LifeLayout:()=>null}));
vi.mock('../../data/local-first',async importOriginal=>({
  ...await importOriginal<typeof import('../../data/local-first')>(),
  enqueueMutation:(...args:unknown[])=>state.enqueue(...args),
  getCached:(...args:unknown[])=>state.read(...args),
  setCached:(...args:unknown[])=>{state.writtenOwners.push(state.owner);return state.write(...args);},
}));
import {createForAccount} from './sync';
import {patchCalendarCache} from './habits';
import type {CalendarData} from './model';
function pending() {let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
function setup() {
  state.owner=1;state.writtenOwners=[];
  state.enqueue.mockReset().mockResolvedValue(undefined);
  state.read.mockReset();state.write.mockReset().mockResolvedValue(undefined);
}
const payload={localId:-7,content:'original',clientKey:'stable-original-key'};

it('queues the original owner and payload when the account changes at each asynchronous create boundary',async()=>{
  for(const stage of ['persist','send','apply']) {
    setup();const wait=pending();
    const persist=vi.fn(()=>stage==='persist'?wait.promise:Promise.resolve());
    const send=vi.fn(()=>stage==='send'?wait.promise.then(()=>({insertedId:101})):Promise.resolve({insertedId:101}));
    const apply=vi.fn(()=>stage==='apply'?wait.promise:Promise.resolve());
    const result=createForAccount({ownerId:1,entity:'basic',payload,persist,send,apply});
    await vi.waitFor(()=>expect(stage==='persist'?persist:stage==='send'?send:apply).toHaveBeenCalledOnce());
    state.owner=2;wait.resolve();
    expect(await result).toBe(false);
    expect(state.enqueue).toHaveBeenCalledWith('basic','create',payload,1);
    if(stage==='persist')expect(send).not.toHaveBeenCalled();
    if(stage!=='apply')expect(apply).not.toHaveBeenCalled();
  }
});

it('keeps normal creation and offline fallback behavior while surfacing failed durable enqueue',async()=>{
  setup();const persist=vi.fn(async()=>undefined),send=vi.fn(async()=>({insertedId:101})),apply=vi.fn(async()=>undefined);
  expect(await createForAccount({ownerId:1,entity:'habit',payload,persist,send,apply})).toBe(true);
  expect(apply).toHaveBeenCalledWith({insertedId:101});expect(state.enqueue).not.toHaveBeenCalled();
  send.mockRejectedValue(new Error('offline'));
  expect(await createForAccount({ownerId:1,entity:'habit',payload,persist,send,apply})).toBe(false);
  expect(state.enqueue).toHaveBeenCalledWith('habit','create',payload,1);
  state.enqueue.mockRejectedValue(new Error('disk unavailable'));
  await expect(createForAccount({ownerId:1,entity:'habit',payload,persist,send,apply})).rejects.toThrow('disk unavailable');
});

it('does not patch another account calendar if identity changes while the cache is read',async()=>{
  setup();const wait=pending(),update=vi.fn((value:CalendarData)=>value);
  state.read.mockReturnValue(wait.promise.then(()=>({value:{}})));
  const result=patchCalendarCache('2026-10-31',update,1);
  state.owner=2;wait.resolve();
  await expect(result).rejects.toThrow('账号已切换');
  expect(state.write).not.toHaveBeenCalled();expect(update).not.toHaveBeenCalled();
});

it('allows a normal calendar patch and detects account changes during its original-owner commit',async()=>{
  setup();state.read.mockResolvedValue({value:{}});
  const wait=pending();state.write.mockReturnValue(wait.promise);
  const result=patchCalendarCache('2026-10-31',value=>value,1);
  await vi.waitFor(()=>expect(state.write).toHaveBeenCalledOnce());
  state.owner=2;wait.resolve();await expect(result).rejects.toThrow('账号已切换');
  expect(state.writtenOwners).toEqual([1]);
  setup();state.read.mockResolvedValue({value:{}});
  await patchCalendarCache('2026-10-31',value=>value,1);
  expect(state.writtenOwners).toEqual([1]);
});
