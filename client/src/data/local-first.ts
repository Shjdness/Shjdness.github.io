export type SyncEntity = 'habit' | 'note' | 'basic' | 'pomodoro' | 'rss';
export type SyncItem = { id?: number; entity: SyncEntity; action: string; payload: unknown; createdAt: number; retryCount: number; status: 'pending' | 'syncing' | 'failed'; lastError?: string };
type CacheValue<T> = { key: string; value: T; updatedAt: number };
type SavedAdvice = { id: string; savedAt: number };

const DB_NAME = 'shjdshy-life';
const DB_VERSION = 1;
const CHANGE_EVENT = 'shjdshy-local-change';

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('sync_queue')) db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('saved_advice')) db.createObjectStore('saved_advice', { keyPath: 'id' });
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
  const record = await storeRequest<CacheValue<T> | undefined>('cache', 'readonly', store => store.get(key));
  return record || null;
}

export async function setCached<T>(key: string, value: T) {
  await storeRequest('cache', 'readwrite', store => store.put({ key, value, updatedAt: Date.now() }));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export async function enqueueMutation(entity: SyncEntity, action: string, payload: unknown) {
  await storeRequest('sync_queue', 'readwrite', store => store.add({ entity, action, payload, createdAt: Date.now(), retryCount: 0, status: 'pending' } satisfies SyncItem));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export async function getSyncQueue() {
  return storeRequest<SyncItem[]>('sync_queue', 'readonly', store => store.getAll());
}

export type SyncResult = { total: number; synced: number; failed: number; offline: boolean };

export async function flushSyncQueue(send: (item: SyncItem) => Promise<boolean>): Promise<SyncResult> {
  const queue = await getSyncQueue();
  if (!navigator.onLine) return { total: queue.length, synced: 0, failed: queue.length, offline: true };
  let synced = 0;
  let failed = 0;
  for (const item of queue) {
    if (!item.id) continue;
    try {
      await storeRequest('sync_queue', 'readwrite', store => store.put({ ...item, status: 'syncing', lastError: undefined }));
      const sent = await send(item);
      if (sent) { await storeRequest('sync_queue', 'readwrite', store => store.delete(item.id!)); synced += 1; }
      else { await storeRequest('sync_queue', 'readwrite', store => store.put({ ...item, retryCount: item.retryCount + 1, status: 'failed', lastError: '服务器未确认写入' })); failed += 1; }
    } catch (error) {
      const lastError = error instanceof Error ? error.message.slice(0, 240) : '同步失败';
      await storeRequest('sync_queue', 'readwrite', store => store.put({ ...item, retryCount: item.retryCount + 1, status: 'failed', lastError }));
      failed += 1;
    }
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  return { total: queue.length, synced, failed, offline: false };
}

export async function getSavedAdviceIds() {
  const records = await storeRequest<SavedAdvice[]>('saved_advice', 'readonly', store => store.getAll());
  return records.map(record => record.id);
}

export async function setAdviceSaved(id: string, saved: boolean) {
  if (saved) await storeRequest('saved_advice', 'readwrite', store => store.put({ id, savedAt: Date.now() } satisfies SavedAdvice));
  else await storeRequest('saved_advice', 'readwrite', store => store.delete(id));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export const onLocalChange = (listener: () => void) => {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
};
