import { describe, expect, it, vi } from 'vitest';
import { processSyncQueue, type SyncItem } from './local-first';

const item = (id: number): SyncItem => ({ id, entity: 'todo', action: 'create', payload: {}, createdAt: 1, retryCount: 0, status: 'pending' });

describe('sync queue processor', () => {
  it('does not send while offline', async () => {
    const send = vi.fn(async () => true);
    const storage = { markSyncing: vi.fn(), remove: vi.fn(), markFailed: vi.fn(async (_item: SyncItem, _error: string) => undefined) };
    expect(await processSyncQueue([item(1)], false, send, storage)).toEqual({ total: 1, synced: 0, failed: 1, offline: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('removes only server-confirmed writes', async () => {
    const storage = { markSyncing: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), markFailed: vi.fn(async (_item: SyncItem, _error: string) => undefined) };
    const result = await processSyncQueue([item(1), item(2)], true, async current => current.id === 1, storage);
    expect(result).toEqual({ total: 2, synced: 1, failed: 1, offline: false });
    expect(storage.remove).toHaveBeenCalledWith(1);
    expect(storage.markFailed).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), '服务器未确认写入');
  });

  it('retains failed writes with a bounded error message', async () => {
    const storage = { markSyncing: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), markFailed: vi.fn(async (_item: SyncItem, _error: string) => undefined) };
    await processSyncQueue([item(1)], true, async () => { throw new Error('x'.repeat(300)); }, storage);
    const message = storage.markFailed.mock.calls[0]?.[1];
    expect(message).toHaveLength(240);
    expect(storage.remove).not.toHaveBeenCalled();
  });
});
