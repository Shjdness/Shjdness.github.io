import {it,expect,vi,afterEach} from 'vitest';
import {notify} from './webhook';
afterEach(()=>vi.unstubAllGlobals());
it('bounds notification fetches and never rejects an already saved comment',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  for(const url of ['','http://example.invalid','https://user:pass@example.invalid'])expect(await notify(url,'fixture')).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRejectedValueOnce(new Error('private endpoint diagnostics'));
  await expect(notify('https://notify.invalid/hook','fixture')).resolves.toBe(false);
  fetch.mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://other.invalid'}}));
  expect(await notify('https://notify.invalid/hook','fixture')).toBe(false);
  fetch.mockResolvedValueOnce(new Response(null,{status:204}));
  expect(await notify('https://notify.invalid/hook','fixture')).toBe(true);
  expect(fetch.mock.calls.every(([,init])=>init.redirect==='manual' && init.signal instanceof AbortSignal)).toBe(true);
});
