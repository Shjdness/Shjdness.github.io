import {expect,it,vi} from 'vitest';
import {reportMailProvider} from './report-mail-provider';

const key='a'.repeat(64),message={to:'fixture@example.invalid',deliveryKey:key,subject:'统计',text:'仅统计数字',html:'<p>仅统计数字</p>'};
const config={identity:'fixture-v1',apiKey:'fixture-provider-key-only',from:'sender@example.invalid'};

it('submits one fixed Resend request with stable opaque idempotency/tag and no unexpected fields',async()=>{
  const fetcher=vi.fn(async()=>Response.json({id:'provider-1'}));
  const provider=reportMailProvider({...config,kind:'resend',fetcher});
  expect(fetcher).not.toHaveBeenCalled();
  expect(await provider.submit(message,new AbortController().signal)).toEqual({state:'accepted',id:'provider-1'});
  const [url,request]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe('https://api.resend.com/emails');expect(request.redirect).toBe('error');
  expect(request.headers).toMatchObject({'Idempotency-Key':'life-report-'+key,Authorization:'Bearer '+config.apiKey});
  expect(JSON.parse(String(request.body))).toEqual({from:config.from,to:[message.to],subject:message.subject,text:message.text,html:message.html,tags:[{name:'report_delivery',value:key}]});
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('submits one Brevo text-only body and accepts standard Message-ID',async()=>{
  const fetcher=vi.fn(async()=>Response.json({messageId:'<fixture@relay.example.invalid>'}));
  const provider=reportMailProvider({...config,kind:'brevo',fetcher});
  expect(await provider.submit(message,new AbortController().signal)).toEqual({state:'accepted',id:'fixture@relay.example.invalid'});
  const [url,request]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe('https://api.brevo.com/v3/smtp/email');expect(request.headers).toMatchObject({'api-key':config.apiKey});
  expect(JSON.parse(String(request.body))).toEqual({sender:{email:config.from,name:'夏令时电波'},to:[{email:message.to}],subject:message.subject,textContent:message.text,tags:['report_delivery_'+key]});
});

it('never retries errors or uncertain/malformed/oversize acceptance and never exposes response diagnostics',async()=>{
  for(const response of [new Response('PRIVATE PROVIDER DIAGNOSTIC',{status:403}),new Response('PRIVATE PROVIDER DIAGNOSTIC',{status:429}),new Response('PRIVATE PROVIDER DIAGNOSTIC',{status:408}),new Response('PRIVATE PROVIDER DIAGNOSTIC',{status:409}),new Response('PRIVATE PROVIDER DIAGNOSTIC',{status:503}),new Response('bad json'),Response.json({id:'a'.repeat(257)}),new Response('x'.repeat(8193))]){
    const expected=response.status>=400&&response.status<500&&![408,409].includes(response.status)?'rejected':'unknown';
    const fetcher=vi.fn(async()=>response),provider=reportMailProvider({...config,kind:'resend',fetcher});
    expect(await provider.submit(message,new AbortController().signal)).toEqual({state:expected});expect(fetcher).toHaveBeenCalledTimes(1);
  }
  const fetcher=vi.fn(async()=>{throw Error('PRIVATE KEY');});
  expect(await reportMailProvider({...config,kind:'brevo',fetcher}).submit(message,new AbortController().signal)).toEqual({state:'unknown'});expect(fetcher).toHaveBeenCalledTimes(1);
});

it('rejects unsafe configuration/headers and cancels bounded response reads on abort',async()=>{
  for(const bad of [{apiKey:'secret\nHeader: inject'},{from:'victim@example.invalid,other@example.invalid'},{disallowedSecrets:[config.apiKey]},{identity:'with spaces'}])expect(()=>reportMailProvider({...config,kind:'resend',...bad})).toThrow('Invalid');
  const fetcher=vi.fn(async()=>new Response(new ReadableStream({start(){}}))),controller=new AbortController();
  const provider=reportMailProvider({...config,kind:'resend',fetcher}),pending=provider.submit(message,controller.signal);
  await Promise.resolve();await Promise.resolve();controller.abort();
  expect(await pending).toEqual({state:'unknown'});
  const before=fetcher.mock.calls.length;expect(await provider.submit(message,controller.signal)).toEqual({state:'unknown'});expect(fetcher).toHaveBeenCalledTimes(before);
});
