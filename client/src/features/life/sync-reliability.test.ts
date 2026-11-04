import {beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('typescript-cookie',()=>({getCookie:()=>`x.${btoa(JSON.stringify({id:1}))}.x`}));
vi.mock('./model',()=>({lifeApi:vi.fn()}));
import {lifeApi} from './model';
import {sendQueuedMutation} from './sync';
import {processSyncQueue,SyncConflictError,SyncPauseError,type SyncItem} from '../../data/local-first';
const note:SyncItem={id:1,ownerId:1,entity:'note',action:'save',payload:{date:'2026-10-30',content:'local',updatedAt:'2026-10-30T00:00:00Z'},createdAt:1,retryCount:0,status:'pending'};
describe('offline conflict and quota preservation',()=>{
  beforeEach(()=>vi.clearAllMocks());
  it('never acknowledges saved:false or deletes the conflicting local content',async()=>{
    vi.mocked(lifeApi).mockResolvedValue({saved:false,note:{content:'remote',revision:2}});
    await expect(sendQueuedMutation(note)).rejects.toBeInstanceOf(SyncConflictError);
    const storage={markSyncing:vi.fn(),remove:vi.fn(),markFailed:vi.fn()};
    await processSyncQueue([note],true,sendQueuedMutation,storage);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(storage.markFailed).toHaveBeenCalledWith(expect.objectContaining({status:'conflict',payload:note.payload,remote:{content:'remote',revision:2}}),expect.any(String));
  });
  it('does not resend conflicts; stops the batch on quota exhaustion',async()=>{
    const storage={markSyncing:vi.fn(),remove:vi.fn(),markFailed:vi.fn()},send=vi.fn(async()=>{throw new SyncPauseError('paused',1);});
    await processSyncQueue([{...note,status:'conflict'},note,{...note,id:2}],true,send,storage);
    expect(send).toHaveBeenCalledTimes(1);expect(storage.remove).not.toHaveBeenCalled();
  });
  it('rejects writes from a different queued account before making a request',async()=>{
    await expect(sendQueuedMutation({...note,ownerId:2})).rejects.toThrow('账号已切换');
    expect(lifeApi).not.toHaveBeenCalled();
  });
  it('retains a full-day plan as a stopped conflict instead of deleting or endlessly retrying it',async()=>{
    const plan:SyncItem={...note,entity:'basic',action:'create',payload:{date:'2026-11-05',content:'local tomorrow plan',localId:-1,sortOrder:0,clientKey:'synthetic-plan'}};
    vi.mocked(lifeApi).mockRejectedValue(new SyncConflictError({message:'该日期已有三件事'}));
    const storage={markSyncing:vi.fn(),remove:vi.fn(),markFailed:vi.fn()};
    await processSyncQueue([plan],true,sendQueuedMutation,storage);
    expect(storage.remove).not.toHaveBeenCalled();expect(storage.markFailed).toHaveBeenCalledWith(expect.objectContaining({status:'conflict',payload:plan.payload}),expect.any(String));
    vi.mocked(lifeApi).mockClear();await processSyncQueue([{...plan,status:'conflict'}],true,sendQueuedMutation,storage);expect(lifeApi).not.toHaveBeenCalled();
  });
});
