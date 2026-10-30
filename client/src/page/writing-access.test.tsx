import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfileContext, type Profile } from '../state/profile';
import { writingAccountId } from '../utils/writing-access';
import { Cache } from '../utils/cache';
import { WritingPage } from './writing';

const cookies = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock('typescript-cookie', () => ({ getCookie: () => cookies.token }));
vi.mock('../main', () => ({ client: {} }));
vi.mock('../components/markdown', () => ({ Markdown: () => null }));
vi.mock('@monaco-editor/react', () => ({ default: () => null }));
vi.mock('mermaid', () => ({ default: {} }));
vi.mock('../utils/darkModeUtils', () => ({ useColorMode: () => 'dark' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const tokenFor = (id: number) => `x.${btoa(JSON.stringify({ id }))}.x`;
const owner: Profile = { id: 1, name: 'owner', avatar: '', role: 'owner', canWrite: true, permission: true };
const trusted: Profile = { ...owner, id: 2, role: 'trusted', permission: false };
const member: Profile = { ...owner, id: 3, role: 'member', permission: false, canWrite: false };

afterEach(() => { cookies.token = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('writing page identity boundary', () => {
  it('keeps owner and trusted writers, including the legacy owner permission flag', () => {
    expect(writingAccountId(owner, tokenFor(1))).toBe(1);
    expect(writingAccountId(trusted, tokenFor(2))).toBe(2);
    expect(writingAccountId({ ...owner, canWrite: undefined } as unknown as Profile, tokenFor(1))).toBe(1);
    expect(writingAccountId({ ...member, canWrite: undefined } as unknown as Profile, tokenFor(3))).toBeNull();
  });

  it('still mounts the existing editor and retains a permitted writer’s local draft', () => {
    vi.stubGlobal('document', { URL: 'https://local.invalid/blog/writing' });
    const values = new Map([['new/title', 'Synthetic draft title']]);
    const read = vi.fn((key: string) => values.get(key) ?? null);
    const write = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal('localStorage', { getItem: read, setItem: write, removeItem: remove });
    for (const profile of [owner, trusted]) {
      cookies.token = tokenFor(profile.id);
      const html = renderToStaticMarkup(
        React.createElement(ProfileContext.Provider, { value: profile }, React.createElement(WritingPage)),
      );
      expect(html).toContain('Synthetic draft title');
      expect(html).not.toContain('请先登录有写作权限的账号');
    }
    expect(read).toHaveBeenCalledWith('new/content');
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('does not read or modify old local drafts for anonymous, member or stale accounts', () => {
    const read = vi.fn(() => { throw new Error('private local draft must not be read'); });
    const write = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal('localStorage', { getItem: read, setItem: write, removeItem: remove });
    const cache = vi.spyOn(Cache, 'with');
    const denied: [Profile | undefined, string | undefined][] = [
      [undefined, undefined], [undefined, tokenFor(1)], [owner, undefined],
      [member, tokenFor(3)], [owner, tokenFor(2)], [trusted, tokenFor(1)],
      [owner, 'broken'], [owner, 'x.not-json.x'],
      [{ ...owner, id: 0 }, tokenFor(0)], [{ ...owner, id: 1.5 }, tokenFor(1.5)],
    ];
    for (const [profile, token] of denied) {
      cookies.token = token;
      for (const id of [undefined, 42]) {
        const html = renderToStaticMarkup(
          React.createElement(ProfileContext.Provider, { value: profile }, React.createElement(WritingPage, { id })),
        );
        expect(html).toContain('请先登录有写作权限的账号');
        expect(html).toContain('本地稿件已保留');
      }
    }
    expect(cache).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
