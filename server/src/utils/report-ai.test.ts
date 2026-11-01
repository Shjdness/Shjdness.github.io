import {expect,it,vi} from 'vitest';
import {reportWindow,type LifeReportPreview} from './life-report';
import {analyzeReport,reportAIInput,reportAIRequestKey} from './report-ai';
const report:LifeReportPreview={version:1,ownerId:1,generatedAt:'2026-11-02T00:00:00Z',period:reportWindow('daily',new Date('2026-11-02T00:00:00Z')),coverage:'server-synced-only',mode:'statistics-preview',achievementsRecorded:2,tasksCompleted:1,ideasCreated:0,focus:{completedSessions:1,recordedMinutes:7,earlySessions:1},habitCompletions:1,daysWithNotes:1,aiEnabled:false,emailEnabled:false};
const analysis={summary:'本周期已有记录的进展。',observations:['保留小成果记录。'],actions:['选择一件容易开始的小事。']};
const response=()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(analysis)}}]});
const options=()=>({report,apiKey:'synthetic-not-a-real-key',enabled:true,now:new Date('2026-11-02T00:00:00Z'),reserve:vi.fn(async()=>true)});

it('projects numeric values only and uses the official fixed endpoint without tools or redirects',async()=>{
  const input={...report,diary:'private fixture',todoName:'secret task',recipient:'fixture@invalid',ownerName:'private owner'};
  expect(Object.values(reportAIInput(input)).every(v=>Number.isSafeInteger(v))).toBe(true);
  const fetcher=vi.fn(async()=>response()),config={...options(),report:input,fetcher};
  expect(await analyzeReport(config)).toMatchObject({mode:'ai',model:'deepseek-flash',analysis});
  expect(config.reserve).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledOnce();
  const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe('https://api.deepseek.com/chat/completions');expect(init.redirect).toBe('error');
  const body=JSON.parse(init.body as string);
  expect(body).toMatchObject({model:'deepseek-flash',thinking:{type:'disabled'},max_tokens:768,response_format:{type:'json_object'}});
  expect(body).not.toHaveProperty('tools');expect(body).not.toHaveProperty('user_id');
  expect(body.messages[1].content).not.toMatch(/private|secret|invalid|2026|ownerId/);
  expect(init.body).not.toContain(config.apiKey);
});

it('does not spend on missing configuration, disabled AI, stale pricing, duplicate jobs or exhausted budget',async()=>{
  const fetcher=vi.fn(async()=>response());
  for(const patch of [{apiKey:undefined},{enabled:false},{now:new Date('2026-12-01T00:00:00+08:00')},{reserve:vi.fn(async()=>false)}]){
    expect((await analyzeReport({...options(),...patch,fetcher})).mode).toBe('statistics');
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it('fails closed on provider errors, malformed/truncated/oversized output and a stalled response body without retry',async()=>{
  const broken=[()=>new Response('provider diagnostic with sensitive content',{status:429}),()=>Response.json({choices:[{finish_reason:'length',message:{content:JSON.stringify(analysis)}}]}),()=>Response.json({choices:[{finish_reason:'stop',message:{content:'   '}}]}),()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({...analysis,actions:['https://bad.invalid']})}}]}),()=>new Response('x'.repeat(33000))];
  for(const makeResponse of broken){
    const fetcher=vi.fn(async()=>makeResponse()),config={...options(),fetcher};
    expect(await analyzeReport(config)).toEqual({mode:'statistics',reason:'unavailable'});
    expect(config.reserve).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledOnce();
  }
  const fetcher=vi.fn(async()=>new Response(new ReadableStream({start(){}})));
  expect(await analyzeReport({...options(),fetcher,timeoutMs:10})).toEqual({mode:'statistics',reason:'unavailable'});
  expect(fetcher).toHaveBeenCalledOnce();
});

it('binds analysis admission to a saved report and digest, independent of later request time',async()=>{
  const saved={id:11,ownerId:1,sha256:'a'.repeat(64)};
  expect(await reportAIRequestKey(saved)).toBe(await reportAIRequestKey(saved));
  expect(await reportAIRequestKey({...saved,sha256:'b'.repeat(64)})).not.toBe(await reportAIRequestKey(saved));
  expect(await reportAIRequestKey({...saved,ownerId:2})).not.toBe(await reportAIRequestKey(saved));
  await expect(reportAIRequestKey({...saved,id:0})).rejects.toThrow('Stored report');
});
