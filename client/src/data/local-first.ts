import { getCookie } from 'typescript-cookie';

export type SyncEntity = 'habit' | 'note' | 'basic' | 'todo' | 'pomodoro' | 'rss';
export type SyncItem = { id?: number; ownerId?: number; entity: SyncEntity; action: string; payload: unknown; createdAt: number; retryCount: number; status: 'pending' | 'syncing' | 'failed'; lastError?: string };
type CacheValue<T> = { key: string; value: T; updatedAt: number };

const DB_NAME = 'shjdshy-life';
const DB_VERSION = 2;
const CHANGE_EVENT = 'shjdshy-local-change';
type LocalChangeKind = 'cache' | 'queue';
const announceChange = (kind: LocalChangeKind) => window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: kind }));

export function accountIdFromToken(token?: string) {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return Number.isSafeInteger(decoded.id) && decoded.id > 0 ? decoded.id as number : null;
  } catch { return null; }
}

const currentAccountId = () => accountIdFromToken(getCookie('token'));
export const accountStorageKey = (key: string, ownerId: number) => `account:${ownerId}:${key}`;
const scopedCacheKey = (key: string) => {
  if (!key.startsWith('life:')) return key;
  const ownerId = currentAccountId();
  return ownerId ? accountStorageKey(key, ownerId) : null;
};

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('sync_queue')) db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true });
      request.transaction?.objectStore('cache').delete('static:life-guide');
      if (db.objectStoreNames.contains('saved_advice')) db.deleteObjectStore('saved_advice');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeRequest<T>(storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export const withTimeout = <T>(promise: Promise<T>, ms = 3000) => Promise.race<T>([
  promise,
  new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error('请求超时，已使用本地数据')), ms)),
]);

export async function getCached<T>(key: string) {
  const scopedKey = scopedCacheKey(key);
  if (!scopedKey) return null;
  const record = await storeRequest<CacheValue<T> | undefined>('cache', 'readonly', store => store.get(scopedKey));
  return record || null;
}

export async function setCached<T>(key: string, value: T) {
  const scopedKey = scopedCacheKey(key);
  if (!scopedKey) throw new Error('Authenticated account required for private cache');
  await storeRequest('cache', 'readwrite', store => store.put({ key: scopedKey, value, updatedAt: Date.now() }));
  announceChange('cache');
}

export async function clearLegacyRssCaches() {
  const ownerId = currentAccountId();
  const scopedPrefix = ownerId ? accountStorageKey('life:rss:', ownerId) : '';
  const keys = await storeRequest<IDBValidKey[]>('cache', 'readonly', store => store.getAllKeys());
  for (const key of keys) {
    if (typeof key === 'string' && ((key.startsWith('life:rss:') && !key.startsWith('life:rss:youtube:v3:')) || (scopedPrefix && key.startsWith(scopedPrefix) && !key.startsWith(`${scopedPrefix}youtube:v3:`)))) {
      await storeRequest('cache', 'readwrite', store => store.delete(key));
    }
  }
}

export async function enqueueMutation(entity: SyncEntity, action: string, payload: unknown) {
  const ownerId = currentAccountId();
  if (!ownerId) throw new Error('Authenticated account required for offline write');
  await storeRequest('sync_queue', 'readwrite', store => store.add({ ownerId, entity, action, payload, createdAt: Date.now(), retryCount: 0, status: 'pending' } satisfies SyncItem));
  announceChange('queue');
}

export async function getSyncQueue() {
  const ownerId = currentAccountId();
  if (!ownerId) return [];
  const queue = await storeRequest<SyncItem[]>('sync_queue', 'readonly', store => store.getAll());
  return queueForAccount(queue, ownerId);
}

export const hasPendingSync = (queue: SyncItem[]) => queue.some(item => item.status !== 'failed');

export const queueForAccount = (queue: SyncItem[], ownerId: number) => queue.filter(item => item.ownerId === ownerId);

export async function getLegacySyncQueueCount() {
  const queue = await storeRequest<SyncItem[]>('sync_queue', 'readonly', store => store.getAll());
  return queue.filter(item => item.ownerId === undefined).length;
}

export type SyncResult = { total: number; synced: number; failed: number; offline: boolean };

type SyncQueueStorage = {
  markSyncing: (item: SyncItem) => Promise<void>;
  remove: (id: number) => Promise<void>;
  markFailed: (item: SyncItem, error: string) => Promise<void>;
};

export async function processSyncQueue(
  queue: SyncItem[],
  online: boolean,
  send: (item: SyncItem) => Promise<boolean>,
  storage: SyncQueueStorage,
): Promise<SyncResult> {
  if (!online) return { total: queue.length, synced: 0, failed: queue.length, offline: true };
  let synced = 0;
  let failed = 0;
  for (const item of queue) {
    if (!item.id) continue;
    try {
      await storage.markSyncing(item);
      if (await send(item)) {
        await storage.remove(item.id);
        synced += 1;
      } else {
        await storage.markFailed(item, '服务器未确认写入');
        failed += 1;
      }
    } catch (error) {
      await storage.markFailed(item, error instanceof Error ? error.message.slice(0, 240) : '同步失败');
      failed += 1;
    }
  }
  return { total: queue.length, synced, failed, offline: false };
}

export async function flushSyncQueue(send: (item: SyncItem) => Promise<boolean>): Promise<SyncResult> {
  const queue = await getSyncQueue();
  if (!queue.length) return { total: 0, synced: 0, failed: 0, offline: !navigator.onLine };
  const result = await processSyncQueue(queue, navigator.onLine, send, {
    markSyncing: async item => { await storeRequest('sync_queue', 'readwrite', store => store.put({ ...item, status: 'syncing', lastError: undefined })); },
    remove: async id => { await storeRequest('sync_queue', 'readwrite', store => store.delete(id)); },
    markFailed: async (item, lastError) => { await storeRequest('sync_queue', 'readwrite', store => store.put({ ...item, retryCount: item.retryCount + 1, status: 'failed', lastError })); },
  });
  announceChange('queue');
  return result;
}

export const onLocalChange = (listener: (kind: LocalChangeKind) => void) => {
  const handler = (event: Event) => listener((event as CustomEvent<LocalChangeKind>).detail);
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
};
