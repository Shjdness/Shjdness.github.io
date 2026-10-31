import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cache } from './cache';
import { createWritingRevision, loadWritingRecord } from './writing-load';

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
  return { rows, write, apply: (data: RecordData, unchanged: (field?: string) => boolean = () => true) => {
    if (unchanged('content')) cache.set('content', data.content);
  } };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('writing cloud load lifecycle', () => {
  it('reuses the original edit checkpoint across failed loads and retries', async () => {
    for (const editDuringRetry of [false, true]) {
      const draft = draftStorage();
      const revision = createWritingRevision();
      const unchanged = revision.checkpoint();
      const failure = vi.fn(), conflict = vi.fn();
      await loadWritingRecord(async () => { throw new Error('offline'); }, () => true, draft.apply, failure,
        { unchanged, onChanged: conflict });
      const type = revision.track('content', (content: string) => draft.apply({ content }));
      type('Typed before retry');
      const pending = pendingLoad();
      const retry = loadWritingRecord(() => pending.promise, () => true, draft.apply, failure,
        { unchanged, onChanged: conflict });
      if (editDuringRetry) type('Typed during retry');
      pending.resolve({ data: { content: 'Older cloud text' } });
      await retry;
      expect(draft.rows.get('42/content')).toBe(editDuringRetry ? 'Typed during retry' : 'Typed before retry');
      expect(failure).toHaveBeenCalledOnce();
      expect(conflict).toHaveBeenCalledOnce();
    }
  });

  it('does not mistake partial cloud writes for human edits when storage failure is retried', async () => {
    const rows = new Map([['42/content', 'Local body'], ['42/kind', 'article']]);
    let failKind = true, ready = false;
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => rows.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === '42/kind' && failKind) { failKind = false; throw new Error('storage temporarily unavailable'); }
        rows.set(key, value);
      }, removeItem: vi.fn(),
    });
    const cache = Cache.with(42), revision = createWritingRevision();
    const unchanged = revision.checkpoint();
    const failure = vi.fn(), conflict = vi.fn();
    const apply = (data: { content: string; kind: string }, fieldUnchanged: (field?: string) => boolean) => {
      if (fieldUnchanged('content')) cache.set('content', data.content);
      if (fieldUnchanged('kind')) cache.set('kind', data.kind);
      ready = true;
    };
    const request = async () => ({ data: { content: 'Cloud body', kind: 'diary' } });
    await loadWritingRecord(request, () => true, apply, failure, { unchanged, onChanged: conflict });
    expect(ready).toBe(false);
    expect(unchanged()).toBe(true);
    await loadWritingRecord(request, () => true, apply, failure, { unchanged, onChanged: conflict });
    expect(ready).toBe(true);
    expect(rows.get('42/kind')).toBe('diary');
    expect(rows.get('42/content')).toBe('Cloud body');
    expect(failure).toHaveBeenCalledOnce();
    expect(conflict).not.toHaveBeenCalled();
  });

  it('loads normally when no edits were made after the request checkpoint', async () => {
    const revision = createWritingRevision();
    const draft = draftStorage();
    const conflict = vi.fn();
    await loadWritingRecord(async () => ({ data: { content: 'Cloud draft' } }), () => true, draft.apply, vi.fn(), {
      unchanged: revision.checkpoint(), onChanged: conflict,
    });
    expect(draft.rows.get('42/content')).toBe('Cloud draft');
    expect(conflict).not.toHaveBeenCalled();
  });

  it('keeps newly typed local content when a delayed cloud response arrives', async () => {
    const revision = createWritingRevision();
    const draft = draftStorage();
    const pending = pendingLoad();
    const conflict = vi.fn();
    const failure = vi.fn();
    const result = loadWritingRecord(() => pending.promise, () => true, draft.apply, failure, {
      unchanged: revision.checkpoint(), onChanged: conflict,
    });
    revision.track('content', (content: string) => draft.apply({ content }))('New local input');
    pending.resolve({ data: { content: 'Older cloud content' } });
    await result;
    expect(draft.rows.get('42/content')).toBe('New local input');
    expect(draft.write).toHaveBeenCalledTimes(1);
    expect(conflict).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
  });

  it('also protects title, summary, tags, kind and date changes, including undo to the original value', async () => {
    for (const field of ['title', 'summary', 'tags', 'kind', 'createdAt']) {
      const revision = createWritingRevision();
      const pending = pendingLoad();
      const draft = draftStorage();
      const fields = new Map([[field, 'original']]);
      const apply = vi.fn((data: RecordData, unchanged: (field?: string) => boolean) => {
        draft.apply(data, unchanged);
        if (unchanged(field)) fields.set(field, 'cloud metadata');
      });
      const conflict = vi.fn();
      const result = loadWritingRecord(() => pending.promise, () => true, apply, vi.fn(), {
        unchanged: revision.checkpoint(), onChanged: conflict,
      });
      const edit = revision.track(field, (value: string) => fields.set(field, value));
      edit('changed');
      edit('original');
      pending.resolve({ data: { content: 'Old cloud version' } });
      await result;
      expect(fields.get(field)).toBe('original');
      expect(apply).toHaveBeenCalledOnce();
      expect(draft.rows.get('42/content')).toBe('Old cloud version');
      expect(conflict).toHaveBeenCalledOnce();
    }
  });

  it('silences edit-conflict callbacks after the original editor becomes obsolete', async () => {
    const revision = createWritingRevision();
    const pending = pendingLoad();
    const draft = draftStorage();
    const conflict = vi.fn();
    let live = true;
    const result = loadWritingRecord(() => pending.promise, () => live, draft.apply, vi.fn(), {
      unchanged: revision.checkpoint(), onChanged: conflict,
    });
    revision.track('content', vi.fn())('typing');
    live = false;
    pending.resolve({ data: { content: 'Late cloud response' } });
    await result;
    expect(conflict).not.toHaveBeenCalled();
    expect(draft.write).not.toHaveBeenCalled();
  });

  it('loads untouched private kind and creation date while retaining newly typed content', async () => {
    const revision = createWritingRevision();
    const draft = draftStorage();
    const state = { kind: 'article', createdAt: 'new default date' };
    const unchanged = revision.checkpoint();
    revision.track('content', (content: string) => draft.apply({ content }))('New local input');
    await loadWritingRecord(async () => ({ data: { content: 'Cloud content', kind: 'diary', createdAt: '2020-01-01' } }),
      () => true,
      (data, fieldUnchanged) => {
        draft.apply(data, fieldUnchanged);
        if (fieldUnchanged('kind')) state.kind = data.kind;
        if (fieldUnchanged('createdAt')) state.createdAt = data.createdAt;
      }, vi.fn(), { unchanged, onChanged: vi.fn() });
    expect(draft.rows.get('42/content')).toBe('New local input');
    expect(state).toEqual({ kind: 'diary', createdAt: '2020-01-01' });
  });

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
