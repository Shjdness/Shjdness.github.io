import {expect,it,vi} from 'vitest';
import {loadReportPreview} from './report-preview';
const report={version:1,ownerId:1,generatedAt:'2026-11-02T00:00:00Z',period:{kind:'daily',timezone:'Asia/Shanghai'},coverage:'server-synced-only',mode:'statistics-preview',achievementsRecorded:1,tasksCompleted:1,ideasCreated:0,habitCompletions:0,daysWithNotes:0,focus:{completedSessions:1,recordedMinutes:7,earlySessions:1}};

it('uses a private authenticated request and rejects owner/format mismatches',async()=>{
  const controller=new AbortController();
  const fetcher=vi.fn(async()=>Response.json(report));
  const options={endpoint:'https://fixture.invalid',token:'owner-token',ownerId:1,kind:'daily' as const,signal:controller.signal,currentToken:()=> 'owner-token',fetcher};
  expect(await loadReportPreview(options)).toEqual(report);
  expect(fetcher).toHaveBeenCalledWith('https://fixture.invalid/life/reports/preview?kind=daily',expect.objectContaining({headers:{Authorization:'Bearer owner-token'},cache:'no-store',credentials:'omit',signal:controller.signal}));
  for(const value of [{...report,ownerId:2},{...report,focus:null},{...report,achievementsRecorded:-1},{...report,period:{kind:'weekly',timezone:'Asia/Shanghai'}}]){
    fetcher.mockResolvedValueOnce(Response.json(value));await expect(loadReportPreview(options)).rejects.toThrow('不匹配');
  }
});

it('rejects late headers/body after switching identities or cancelling',async()=>{
  for(const phase of ['headers','body','abort']){
    const controller=new AbortController();let token='owner-token';
    let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
    let readingBody=false;
    const fetcher=vi.fn(async()=>{if(phase==='headers')await waiting;return {ok:true,json:async()=>{readingBody=true;if(phase!=='headers')await waiting;return report;}} as Response;});
    const result=loadReportPreview({endpoint:'https://fixture.invalid',token,ownerId:1,kind:'daily',signal:controller.signal,currentToken:()=>token,fetcher});
    await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());
    if(phase!=='headers')await vi.waitFor(()=>expect(readingBody).toBe(true));
    if(phase==='abort')controller.abort();else token='other-token';
    release();await expect(result).rejects.toThrow(phase==='abort'?'取消':'账号已切换');
  }
});
