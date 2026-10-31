import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cache } from './cache';
import { createWritingRevision } from './writing-load';
import { completeWritingSave, confirmWritingDraftDeletion } from './writing-save';

function storage() {
  const rows = new Map([
    ['new/title', 'Unrelated new draft'], ['new/content', 'New draft body'],
    ['42/title', 'Submitted draft'], ['42/content', 'Submitted body'],
    ['99/content', 'Another open draft'],
  ]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => { rows.set(key, value); },
    removeItem: (key: string) => { rows.delete(key); },
  });
  return rows;
}
afterEach(() => vi.unstubAllGlobals());

describe('confirmed writing save cleanup', () => {
  it('does not send a stale delete confirmation after identity or input changes', async () => {
    for (const current of [false, true]) {
      const rows = storage(), original = new Map(rows);
      const remove = vi.fn(async () => undefined), edited = vi.fn(), done = vi.fn();
      await confirmWritingDraftDeletion({ isCurrent: () => current, unchanged: () => false, remove, onEdited: edited, afterDeleted: done });
      expect(remove).not.toHaveBeenCalled();
      expect(done).not.toHaveBeenCalled();
      expect(edited).toHaveBeenCalledTimes(current ? 1 : 0);
      expect(rows).toEqual(original);
    }
  });

  it('does not act on a delete response after the original editor becomes obsolete', async () => {
    let resolve!: () => void, current = true;
    const pending = new Promise<void>(yes => { resolve = yes; });
    const done = vi.fn();
    const result = confirmWritingDraftDeletion({ isCurrent: () => current, unchanged: () => true,
      remove: () => pending, onEdited: vi.fn(), afterDeleted: done });
    current = false;
    resolve();
    await result;
    expect(done).not.toHaveBeenCalled();
  });

  it('retains new input during deletion and allows it to be saved as a new record', async () => {
    const rows = storage(), cache = Cache.with(42), revision = createWritingRevision();
    const unchanged = revision.checkpoint(), leave = vi.fn(), retained = vi.fn();
    let resolve!: () => void, recordId: number | undefined = 42;
    const pending = new Promise<void>(yes => { resolve = yes; });
    const result = confirmWritingDraftDeletion({ isCurrent: () => true, unchanged, remove: () => pending, onEdited: vi.fn(),
      afterDeleted: () => {
        recordId = undefined;
        completeWritingSave({ isCurrent: () => true, unchanged, clear: () => cache.clear(), leave, onEdited: retained });
      } });
    revision.track('content', (value: string) => cache.set('content', value))('New text during delete');
    resolve();
    await result;
    expect(recordId).toBeUndefined();
    expect(rows.get('42/content')).toBe('New text during delete');
    expect(rows.get('42/title')).toBe('Submitted draft');
    expect(rows.get('new/content')).toBe('New draft body');
    expect(leave).not.toHaveBeenCalled();
    expect(retained).toHaveBeenCalledOnce();
  });

  it('does not clean local drafts or navigate when delete fails', async () => {
    const rows = storage(), original = new Map(rows), done = vi.fn();
    await expect(confirmWritingDraftDeletion({ isCurrent: () => true, unchanged: () => true,
      remove: async () => { throw new Error('offline or denied'); }, onEdited: vi.fn(), afterDeleted: done })).rejects.toThrow('offline or denied');
    expect(rows).toEqual(original);
    expect(done).not.toHaveBeenCalled();
  });

  it('clears only the submitted existing draft and then navigates', () => {
    const rows = storage();
    const leave = vi.fn(() => { expect(rows.has('42/content')).toBe(false); });
    completeWritingSave({ isCurrent: () => true, unchanged: () => true,
      clear: () => Cache.with(42).clear(), leave, onEdited: vi.fn() });
    expect(leave).toHaveBeenCalledOnce();
    expect(rows.get('new/content')).toBe('New draft body');
    expect(rows.get('99/content')).toBe('Another open draft');
  });

  it('clears a submitted new draft without clearing a different record cache', () => {
    const rows = storage();
    completeWritingSave({ isCurrent: () => true, unchanged: () => true,
      clear: () => Cache.with().clear(), leave: vi.fn(), onEdited: vi.fn() });
    expect(rows.has('new/content')).toBe(false);
    expect(rows.get('42/content')).toBe('Submitted body');
    expect(rows.get('99/content')).toBe('Another open draft');
  });

  it('keeps new input after the request began, including edits made while the success alert is open', async () => {
    for (const afterResponse of [false, true]) {
      const rows = storage();
      const revision = createWritingRevision();
      const unchanged = revision.checkpoint();
      const cache = Cache.with(42);
      const leave = vi.fn(), edited = vi.fn();
      const type = revision.track('content', (value: string) => cache.set('content', value));
      if (!afterResponse) type('Typed while saving');
      await Promise.resolve(); // Simulated successful server acknowledgement.
      if (afterResponse) {
        expect(unchanged()).toBe(true);
        type('Typed while success alert is open');
      }
      completeWritingSave({ isCurrent: () => true, unchanged,
        clear: () => cache.clear(), leave, onEdited: edited });
      expect(rows.get('42/content')).toBe(afterResponse ? 'Typed while success alert is open' : 'Typed while saving');
      expect(rows.get('42/title')).toBe('Submitted draft');
      expect(rows.get('new/content')).toBe('New draft body');
      expect(leave).not.toHaveBeenCalled();
      expect(edited).toHaveBeenCalledOnce();
    }
  });

  it('does not clean up or navigate after token change or editor unmount', () => {
    for (const reason of ['token', 'unmount']) {
      const rows = storage();
      const original = new Map(rows);
      let token = 'first', live = true;
      const captured = token;
      const leave = vi.fn(), edited = vi.fn();
      if (reason === 'token') token = 'second';
      else live = false;
      completeWritingSave({ isCurrent: () => live && token === captured, unchanged: () => false,
        clear: () => Cache.with(42).clear(), leave, onEdited: edited });
      expect(rows).toEqual(original);
      expect(leave).not.toHaveBeenCalled();
      expect(edited).not.toHaveBeenCalled();
    }
  });

  it('does not leave if local cleanup fails', () => {
    const leave = vi.fn();
    expect(() => completeWritingSave({ isCurrent: () => true, unchanged: () => true,
      clear: () => { throw new Error('storage unavailable'); }, leave, onEdited: vi.fn() })).toThrow('storage unavailable');
    expect(leave).not.toHaveBeenCalled();
  });
});
