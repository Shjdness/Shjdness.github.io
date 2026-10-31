import { beforeEach, expect, it, vi } from 'vitest';
import { FeedService } from './feed';
const state=vi.hoisted(()=>({uid:1 as number|undefined,writer:true,admin:false,deleted:true,remove:vi.fn(),invalidate:vi.fn()}));
vi.mock('../setup',async()=>{
  const {default:Elysia}=await import('elysia');
  return {setup:()=>new Elysia({aot:false}).derive({as:'global'},()=>({uid:state.uid,writer:state.writer,admin:state.admin}))};
});
vi.mock('../utils/di',()=>({getDB:()=>({query:{feeds:{findFirst:async()=>({id:8,uid:1,draft:1,alias:null})}}}),getEnv:()=>({DB:{}})}));
vi.mock('../utils/cache',()=>({PublicCache:()=>({deletePrefix:state.invalidate,delete:state.invalidate}),ClientConfig:()=>({})}));
vi.mock('../utils/post-create',async importOriginal=>({
  ...await importOriginal<typeof import('../utils/post-create')>(),
  deletePostWithReceipts:async(...args:unknown[])=>{state.remove(...args);return state.deleted;},
}));
beforeEach(()=>{state.uid=1;state.writer=true;state.admin=false;state.deleted=true;state.remove.mockClear();state.invalidate.mockClear();});
const request=(query='')=>FeedService().handle(new Request('http://local.test/feed/8'+query,{method:'DELETE'}));

it('accepts the optional draft guard, returns conflict without invalidating cache, and keeps legacy delete compatible',async()=>{
  state.deleted=false;
  const conflict=await request('?draftOnly=1');
  expect(conflict.status).toBe(409);
  expect(await conflict.text()).toContain('草稿状态已变化');
  expect(state.remove.mock.calls[0].slice(1)).toEqual([1,8,true]);
  expect(state.invalidate).not.toHaveBeenCalled();
  state.deleted=true;
  expect((await request('?draftOnly=1')).status).toBe(200);
  expect(state.invalidate).toHaveBeenCalled();
  expect((await request()).status).toBe(200);
  expect(state.remove.mock.calls[2].slice(1)).toEqual([1,8,false]);
  expect((await request('?draftOnly=0')).status).toBe(422);
  expect(state.remove).toHaveBeenCalledTimes(3);
});

it('retains owner, trusted-writer and administrator authorization before conditional deletion',async()=>{
  state.uid=2;
  expect((await request('?draftOnly=1')).status).toBe(403);
  expect(state.remove).not.toHaveBeenCalled();
  state.uid=undefined;state.writer=false;
  expect((await request('?draftOnly=1')).status).toBe(403);
  expect(state.remove).not.toHaveBeenCalled();
  state.uid=2;state.admin=true;
  expect((await request('?draftOnly=1')).status).toBe(200);
  expect(state.remove.mock.calls[0].slice(1)).toEqual([1,8,true]);
});
