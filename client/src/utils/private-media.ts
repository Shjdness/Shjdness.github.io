import { getCookie } from 'typescript-cookie';
import { useEffect, useState } from 'react';
import { endpoint } from '../main';

const id = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const maxUploadImageBytes = 5 * 1024 * 1024;
const privateImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
type PrivateMediaAvailability = 'checking' | 'unavailable' | 'paused' | 'ready';
type CheckedAvailability = Exclude<PrivateMediaAvailability, 'checking'>;
let readiness: { status: CheckedAvailability; expiresAt: number } | undefined;
let checking: Promise<CheckedAvailability> | undefined;

export class PrivateMediaUnavailable extends Error {
  constructor() { super('私密图片不可用'); }
}

function apiUrl(path: string) {
  const url = new URL(path, endpoint);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password) throw Error('私密图片服务地址无效');
  return url;
}

function recentAvailability() {
  return readiness && readiness.expiresAt > Date.now() ? readiness.status : undefined;
}

export function readPrivateMediaAvailability(force = false): Promise<CheckedAvailability> {
  const cached = recentAvailability();
  if (!force && cached) return Promise.resolve(cached);
  if (checking) return checking;
  checking = (async (): Promise<CheckedAvailability> => {
    try {
      const response = await fetch(apiUrl('/reliability/capabilities'), {
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return 'unavailable';
      }
      const value = await response.json() as { privateMediaV1?: unknown; privateMediaAvailable?: unknown; privateMediaWritesPaused?: unknown } | null;
      if (value?.privateMediaV1 === true && value.privateMediaAvailable === true) {
        return value.privateMediaWritesPaused === false ? 'ready' : 'paused';
      }
    } catch { /* Compatibility, timeout and offline all fail closed. */ }
    return 'unavailable';
  })().then(status => {
    readiness = { status, expiresAt: Date.now() + (status === 'ready' ? 30_000 : 5_000) };
    return status;
  }).finally(() => { checking = undefined; });
  return checking;
}

export function usePrivateMediaAvailability(enabled: boolean, retry = 0): PrivateMediaAvailability {
  const [status, setStatus] = useState<PrivateMediaAvailability>('checking');
  useEffect(() => {
    if (!enabled) {
      setStatus('checking');
      return;
    }
    let current = true;
    const refresh = (force = false) => {
      void readPrivateMediaAvailability(force).then(next => { if (current) setStatus(next); });
    };
    if (retry > 0) setStatus('checking');
    refresh(retry > 0);
    const onFocus = () => refresh();
    const onOnline = () => refresh(true);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    return () => {
      current = false;
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
    };
  }, [enabled, retry]);
  return enabled ? status : 'checking';
}

export function privateMediaWriteMessage(status: PrivateMediaAvailability) {
  if (status === 'checking') return '正在检查私密图片服务';
  if (status === 'paused') return '私密图片上传已暂停，已有图片仍可查看';
  if (status === 'unavailable') return '私密图片服务暂不可用，可继续编辑和保存文字';
  return undefined;
}

export function privateMediaWritesPaused(value: unknown) {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === 'PRIVATE_MEDIA_WRITES_PAUSED');
}

export function parsePrivateMediaReference(value: string): string | null {
  const prefix = 'private-media:';
  const candidate = value.slice(prefix.length);
  return value.startsWith(prefix) && id.test(candidate) ? candidate : null;
}

async function privateMediaRequest<T>(mediaId: string, feedId: number | undefined, signal: AbortSignal, upload: File | undefined, read: (response: Response) => Promise<T>) {
  const token = getCookie('token');
  if (!token || !id.test(mediaId) || (feedId !== undefined && (!Number.isSafeInteger(feedId) || feedId < 1))) throw Error('私密图片请求无效');
  const url = apiUrl(`/storage/private/${mediaId}`);
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
    if ((response.status === 429 || response.status === 503) && upload) {
      const reason = await response.json().catch(() => undefined) as { code?: string } | undefined;
      if (response.status === 503) {
        if (privateMediaWritesPaused(reason)) {
          readiness = { status: 'paused', expiresAt: Date.now() + 5_000 };
          throw Error(privateMediaWriteMessage('paused'));
        }
        throw Error('私密图片请求未完成，请重试');
      }
      throw Error(reason?.code === 'PRIVATE_MEDIA_DAILY_LIMIT'
        ? '已达到私密图片每日上传限额，请在北京时间 08:00 额度刷新后重试'
        : '图片上传过于频繁，请一分钟后重试');
    }
    void response.body?.cancel().catch(() => {});
    if (response.status === 404) throw new PrivateMediaUnavailable();
    if (response.status === 403) throw Error('请使用 GitHub 账号重新登录，访客账号不支持私密图片');
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
