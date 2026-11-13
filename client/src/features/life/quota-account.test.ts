import {afterEach,expect,it,vi} from 'vitest';
const identity=vi.hoisted(()=>({owner:1 as number|null,session:'x'}));
vi.mock('../../main',()=>({endpoint:'https://local.invalid'}));
vi.mock('typescript-cookie',()=>({getCookie:()=>identity.owner?`x.${btoa(JSON.stringify({id:identity.owner}))}.${identity.session}`:undefined}));
import {invalidateLifeTodos,lifeApi,readLifeTodos} from './model';
import {currentWritePause,pauseWrites,SyncPauseError} from '../../data/local-first';
afterEach(()=>{invalidateLifeTodos();vi.unstubAllGlobals();identity.owner=1;identity.session='x';});
function storage() {
  const rows=new Map<string,string>();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>rows.set(key,value)});
  vi.stubGlobal('window',{setTimeout,clearTimeout});
  return rows;
}
function pending<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}

it('shares only a pending todo read in the identical session and discards a superseded read',async()=>{
  storage();
  const beforeWrite=pending<Response>(), afterWrite=pending<Response>();
  const fetch=vi.fn().mockReturnValueOnce(beforeWrite.promise).mockReturnValueOnce(afterWrite.promise).mockResolvedValueOnce(Response.json([{id:3}]));
  vi.stubGlobal('fetch',fetch);
  const first=readLifeTodos();
  expect(readLifeTodos()).toBe(first);
  expect(fetch).toHaveBeenCalledTimes(1);
  invalidateLifeTodos();
  const latest=readLifeTodos();
  beforeWrite.resolve(Response.json([{id:1}]));
  await expect(first).rejects.toThrow('待办已刷新');
  expect(readLifeTodos()).toBe(latest);
  afterWrite.resolve(Response.json([{id:2}]));
  await expect(latest).resolves.toEqual([{id:2}]);
  await expect(readLifeTodos()).resolves.toEqual([{id:3}]);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('does not share todo reads across sign-out, a different account or a new session of the same account',async()=>{
  storage();
  const response=pending<Response>(), accountResponse=pending<Response>();
  const fetch=vi.fn().mockReturnValueOnce(response.promise).mockReturnValueOnce(accountResponse.promise).mockResolvedValueOnce(Response.json([{id:3}]));
  vi.stubGlobal('fetch',fetch);
  const original=readLifeTodos();
  identity.owner=null;
  await expect(readLifeTodos()).rejects.toThrow('请先登录');
  identity.owner=2;
  const other=readLifeTodos();
  identity.owner=1;identity.session='renewed';
  await expect(readLifeTodos()).resolves.toEqual([{id:3}]);
  response.resolve(Response.json([{id:1}]));
  accountResponse.resolve(Response.json([{id:2}]));
  await expect(original).rejects.toThrow('会话已切换');
  await expect(other).rejects.toThrow('会话已切换');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('does not pause the new account when a previous request receives a delayed quota response',async()=>{
  for(const stage of ['fetch','body']) {
    identity.owner=1;const rows=storage(),retryAt=Date.now()+60000;
    const wait=pending<any>();
    const response={ok:false,status:503,text:()=>stage==='body'?wait.promise:Promise.resolve(JSON.stringify({code:'D1_QUOTA_PAUSED',retryAt}))};
    vi.stubGlobal('fetch',vi.fn(()=>stage==='fetch'?wait.promise:Promise.resolve(response)));
    const result=lifeApi('/life/basics',{method:'POST',body:'{}'});
    await Promise.resolve();identity.owner=2;
    wait.resolve(stage==='fetch'?response:JSON.stringify({code:'D1_QUOTA_PAUSED',retryAt}));
    await expect(result).rejects.toBeInstanceOf(SyncPauseError);
    expect(rows.get('account:1:write-pause')).toBe(String(retryAt));
    expect(rows.has('account:2:write-pause')).toBe(false);
    expect(currentWritePause()).toBe(0);
  }
});

it('does not attach an anonymous request quota response to a newly logged-in account',async()=>{
  identity.owner=null;const rows=storage(),wait=pending<any>();
  vi.stubGlobal('fetch',vi.fn(()=>wait.promise));
  const result=lifeApi('/life/overview');identity.owner=2;
  wait.resolve({ok:false,status:503,text:async()=>JSON.stringify({code:'D1_QUOTA_PAUSED',retryAt:Date.now()+60000})});
  await expect(result).rejects.toBeInstanceOf(SyncPauseError);
  expect(rows.size).toBe(0);
});

it('keeps default pause calls and current-account write blocking compatible without pausing on unrelated failures',async()=>{
  const rows=storage(),retryAt=Date.now()+60000;
  pauseWrites(retryAt);expect(currentWritePause()).toBe(retryAt);
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(lifeApi('/life/basics',{method:'POST'})).rejects.toBeInstanceOf(SyncPauseError);
  expect(fetch).not.toHaveBeenCalled();
  identity.owner=2;
  fetch.mockResolvedValue({ok:false,status:403,text:async()=>'Denied'});
  await expect(lifeApi('/life/overview')).rejects.toThrow('Denied');
  expect(rows.has('account:2:write-pause')).toBe(false);
  fetch.mockResolvedValue({ok:true,status:200,headers:new Headers({'content-type':'application/json'}),text:async()=>'{}'});
  await expect(lifeApi('/life/basics',{method:'POST'})).resolves.toEqual({});
});

it('rejects a successful response whose session changed while reading the body', async () => {
  storage();
  const body = pending<string>();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: () => body.promise })));
  const result = lifeApi('/life/overview');
  await Promise.resolve();
  identity.owner = 2;
  body.resolve('{}');
  await expect(result).rejects.toThrow('会话已切换');
});

it('keeps the deadline through the body with a caller signal present', async () => {
  storage();
  const caller = new AbortController();
  vi.stubGlobal('fetch', vi.fn(async (_url, { signal }: RequestInit) => ({
    ok: true,
    text: () => new Promise<string>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }),
  })));
  await expect(lifeApi('/life/overview', { signal: caller.signal }, 10)).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(caller.signal.aborted).toBe(false);
});

it('forwards cancellation from the caller', async () => {
  storage();
  const caller = new AbortController();
  caller.abort(new Error('caller cancelled'));
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(lifeApi('/life/overview', { signal: caller.signal })).rejects.toThrow('caller cancelled');
  expect(fetch).not.toHaveBeenCalled();
});
