import { afterEach, expect, it, vi } from 'vitest';
import { fetchPrivateMedia, parsePrivateMediaReference, PrivateMediaUnavailable, readPrivateMediaAvailability, uploadPrivateMedia } from './private-media';

const account = vi.hoisted(() => ({ token: 'synthetic-token' }));
vi.mock('typescript-cookie', () => ({ getCookie: () => account.token }));
vi.mock('../main', () => ({ endpoint: 'https://api.invalid/' }));
const id = '784f0bfa-6d25-4a21-9f5c-f410fdb7822a';
const signal = () => new AbortController().signal;

afterEach(() => { vi.unstubAllGlobals(); account.token = 'synthetic-token'; });

it('accepts only an exact reference and sends auth to the configured API', async () => {
  expect(parsePrivateMediaReference(`private-media:${id}`)).toBe(id);
  for (const value of [`https://elsewhere.invalid/private-media:${id}`, `%70rivate-media:${id}`, `private-media:${id}?feedId=7`, `private-media:${id.toUpperCase()}`]) {
    expect(parsePrivateMediaReference(value)).toBeNull();
  }
  const fetch = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } }));
  vi.stubGlobal('fetch', fetch);
  const file = await fetchPrivateMedia(id, 42, signal());
  expect(file.type).toBe('image/png');
  expect(fetch).toHaveBeenCalledWith(new URL(`https://api.invalid/storage/private/${id}?feedId=42`), expect.objectContaining({
    method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { Authorization: 'Bearer synthetic-token' },
  }));
  await expect(fetchPrivateMedia('https://elsewhere.invalid', 42, signal())).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});

it('fails closed on a changed session, wrong type, missing binding or invalid receipt', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  fetch.mockResolvedValueOnce(new Response('not an image', { headers: { 'Content-Type': 'image/svg+xml' } }));
  await expect(fetchPrivateMedia(id, undefined, signal())).rejects.toThrow('格式');
  fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
  await expect(fetchPrivateMedia(id, undefined, signal())).rejects.toBeInstanceOf(PrivateMediaUnavailable);
  fetch.mockImplementationOnce(async () => {
    account.token = 'other-session';
    return new Response('fixture', { headers: { 'Content-Type': 'image/png' } });
  });
  await expect(fetchPrivateMedia(id, undefined, signal())).rejects.toThrow('登录状态');
  const file = new File(['synthetic'], 'fixture.png');
  fetch.mockResolvedValueOnce(Response.json({ id: 'unexpected' }));
  await expect(uploadPrivateMedia(file, id, signal())).rejects.toThrow('未确认');
  fetch.mockResolvedValueOnce(Response.json({ id }));
  await expect(uploadPrivateMedia(file, id, signal())).resolves.toBe(`private-media:${id}`);
  expect(fetch).toHaveBeenLastCalledWith(new URL(`https://api.invalid/storage/private/${id}`), expect.objectContaining({ method: 'PUT', body: file }));
});

it('shows separate retry guidance for the durable daily and burst limits', async () => {
  const file = new File(['synthetic'], 'fixture.png');
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  fetch.mockResolvedValueOnce(Response.json({ code: 'PRIVATE_MEDIA_DAILY_LIMIT' }, { status: 429 }));
  fetch.mockResolvedValueOnce(new Response(null, { status: 429 }));
  await expect(uploadPrivateMedia(file, id, signal())).rejects.toThrow('北京时间 08:00');
  await expect(uploadPrivateMedia(file, id, signal())).rejects.toThrow('一分钟后');
});

it('uses only the new anonymous capability for read readiness and explicit write enablement', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  for (const [value, expected] of [
    [{ version: 2 }, 'unavailable'],
    [{ privateMediaV1: true, privateMediaAvailable: false, privateMediaWritesPaused: false }, 'unavailable'],
    [{ privateMediaV1: true, privateMediaAvailable: 'true', privateMediaWritesPaused: false }, 'unavailable'],
    [{ privateMediaV1: true, privateMediaAvailable: true }, 'paused'],
    [{ privateMediaV1: true, privateMediaAvailable: true, privateMediaWritesPaused: true }, 'paused'],
    [{ privateMediaV1: true, privateMediaAvailable: true, privateMediaWritesPaused: false }, 'ready'],
  ] as const) {
    fetch.mockResolvedValueOnce(Response.json(value));
    await expect(readPrivateMediaAvailability(true)).resolves.toBe(expected);
  }
  expect(fetch).toHaveBeenLastCalledWith(new URL('https://api.invalid/reliability/capabilities'), expect.objectContaining({
    credentials: 'omit', cache: 'no-store', redirect: 'error',
  }));
  expect(fetch.mock.lastCall?.[1]?.headers).toBeUndefined();
  await expect(readPrivateMediaAvailability()).resolves.toBe('ready');
  expect(fetch).toHaveBeenCalledTimes(6);
  fetch.mockRejectedValueOnce(new TypeError('offline'));
  const first = readPrivateMediaAvailability(true);
  expect(readPrivateMediaAvailability(true)).toBe(first);
  await expect(first).resolves.toBe('unavailable');
});

it('reports server-side pause when it supersedes an earlier capability response', async () => {
  const file = new File(['synthetic'], 'fixture.png');
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  fetch.mockResolvedValueOnce(Response.json({ code: 'PRIVATE_MEDIA_WRITES_PAUSED' }, { status: 503 }));
  await expect(uploadPrivateMedia(file, id, signal())).rejects.toThrow('已有图片仍可查看');
  await expect(readPrivateMediaAvailability()).resolves.toBe('paused');
  expect(fetch).toHaveBeenCalledOnce();
});
