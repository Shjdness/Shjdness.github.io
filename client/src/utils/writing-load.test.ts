import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cache } from './cache';
import { loadWritingRecord } from './writing-load';

type RecordData = { content: string };
function pendingLoad() {
  let resolve!: (value: { data?: RecordData | null; error?: unknown }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ data?: RecordData | null; error?: unknown }>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function draftStorage() {
  const rows = new Map([['42/content', 'Original local draft']]);
  const write = vi.fn((key: string, value: string) => { rows.set(key, value); });
  vi.stubGlobal('localStorage', { getItem: (key: string) => rows.get(key) ?? null, setItem: write, removeItem: vi.fn() });
  const cache = Cache.with(42);
  return { rows, write, apply: (data: RecordData) => cache.set('content', data.content) };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('writing cloud load lifecycle', () => {
  it('applies the successful response only while the original editor is current', async () => {
    const draft = draftStorage();
    const failure = vi.fn();
    await loadWritingRecord(async () => ({ data: { content: 'Cloud draft' } }), () => true, draft.apply, failure);
    expect(draft.rows.get('42/content')).toBe('Cloud draft');
    expect(draft.write).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();
  });

  it('ignores late success after unmount or an account token change without touching local drafts', async () => {
    for (const reason of ['unmount', 'token-change']) {
      const draft = draftStorage();
      const pending = pendingLoad();
      const failure = vi.fn();
      let live = true, token = 'original-account-token';
      const captured = token;
      const result = loadWritingRecord(() => pending.promise, () => live && token === captured, draft.apply, failure);
      if (reason === 'unmount') live = false;
      else token = 'different-account-token';
      pending.resolve({ data: { content: 'Late cloud response' } });
      await result;
      expect(draft.rows.get('42/content')).toBe('Original local draft');
      expect(draft.write).not.toHaveBeenCalled();
      expect(failure).not.toHaveBeenCalled();
    }
  });

  it('preserves local drafts on network, authorization, empty or malformed responses', async () => {
    const draft = draftStorage();
    const failure = vi.fn();
    for (const response of [{ error: { status: 403 } }, { data: null }, { data: { content: 'Must not apply' }, error: { status: 403 } }]) {
      await loadWritingRecord<RecordData>(async () => response, () => true, draft.apply, failure);
    }
    const unexpected = vi.fn();
    await loadWritingRecord<RecordData | string>(async () => ({ data: 'Unexpected response' }), () => true, unexpected, failure);
    await loadWritingRecord(async () => { throw new Error('offline'); }, () => true, draft.apply, failure);
    expect(failure).toHaveBeenCalledTimes(5);
    expect(unexpected).not.toHaveBeenCalled();
    expect(draft.rows.get('42/content')).toBe('Original local draft');
    expect(draft.write).not.toHaveBeenCalled();
  });

  it('handles a rejected late response silently and skips requests for obsolete editors', async () => {
    const draft = draftStorage();
    const pending = pendingLoad();
    const failure = vi.fn();
    let live = true;
    const result = loadWritingRecord(() => pending.promise, () => live, draft.apply, failure);
    live = false;
    pending.reject(new Error('late network failure'));
    await result;
    const request = vi.fn(async () => ({ data: { content: 'Should not load' } }));
    await loadWritingRecord(request, () => false, draft.apply, failure);
    expect(request).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(draft.write).not.toHaveBeenCalled();
  });
});
