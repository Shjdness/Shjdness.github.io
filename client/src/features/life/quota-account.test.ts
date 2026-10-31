import {afterEach,expect,it,vi} from 'vitest';
const identity=vi.hoisted(()=>({owner:1 as number|null}));
vi.mock('../../main',()=>({endpoint:'https://local.invalid'}));
vi.mock('typescript-cookie',()=>({getCookie:()=>identity.owner?`x.${btoa(JSON.stringify({id:identity.owner}))}.x`:undefined}));
import {lifeApi} from './model';
import {currentWritePause,pauseWrites,SyncPauseError} from '../../data/local-first';
afterEach(()=>{vi.unstubAllGlobals();identity.owner=1;});
function storage() {
  const rows=new Map<string,string>();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>rows.set(key,value)});
  vi.stubGlobal('window',{setTimeout,clearTimeout});
  return rows;
}
function pending<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}

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
