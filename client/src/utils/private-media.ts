import { getCookie } from 'typescript-cookie';
import { endpoint } from '../main';

const id = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const maxUploadImageBytes = 5 * 1024 * 1024;
const privateImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

export class PrivateMediaUnavailable extends Error {
  constructor() { super('私密图片不可用'); }
}

export function parsePrivateMediaReference(value: string): string | null {
  const prefix = 'private-media:';
  const candidate = value.slice(prefix.length);
  return value.startsWith(prefix) && id.test(candidate) ? candidate : null;
}

async function privateMediaRequest<T>(mediaId: string, feedId: number | undefined, signal: AbortSignal, upload: File | undefined, read: (response: Response) => Promise<T>) {
  const token = getCookie('token');
  if (!token || !id.test(mediaId) || (feedId !== undefined && (!Number.isSafeInteger(feedId) || feedId < 1))) throw Error('私密图片请求无效');
  const url = new URL(`/storage/private/${mediaId}`, endpoint);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password) throw Error('私密图片服务地址无效');
  if (feedId !== undefined) url.searchParams.set('feedId', String(feedId));
  const timeout = AbortSignal.timeout(upload ? 20_000 : 10_000);
  const combined = AbortSignal.any([signal, timeout]);
  combined.throwIfAborted();
  const response = await fetch(url, {
    method: upload ? 'PUT' : 'GET', body: upload,
    headers: { Authorization: `Bearer ${token}`, ...(upload ? { 'Content-Type': 'application/octet-stream' } : {}) },
    credentials: 'omit', cache: 'no-store', redirect: 'error', signal: combined,
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 404) throw new PrivateMediaUnavailable();
    if (response.status === 429 && upload) throw Error('图片上传过于频繁，请一分钟后重试');
    throw Error('私密图片请求未完成，请重试');
  }
  const result = await read(response);
  combined.throwIfAborted();
  if (getCookie('token') !== token) throw Error('登录状态已变更');
  return result;
}

export function fetchPrivateMedia(id: string, feedId: number | undefined, signal: AbortSignal) {
  return privateMediaRequest(id, feedId, signal, undefined, async response => {
    if (!privateImageTypes.has(response.headers.get('content-type') || '')) {
      void response.body?.cancel().catch(() => {});
      throw Error('私密图片格式无效');
    }
    const data = await response.blob();
    if (!data.size || data.size > maxUploadImageBytes) throw Error('私密图片大小无效');
    return data;
  });
}

export function uploadPrivateMedia(file: File, operationId: string, signal: AbortSignal) {
  if (!file.size || file.size > maxUploadImageBytes) return Promise.reject(Error('私密图片大小无效'));
  return privateMediaRequest(operationId, undefined, signal, file, async response => {
    const receipt: unknown = await response.json();
    if (!receipt || typeof receipt !== 'object' || !('id' in receipt) || receipt.id !== operationId) throw Error('私密图片上传未确认');
    return `private-media:${operationId}`;
  });
}
