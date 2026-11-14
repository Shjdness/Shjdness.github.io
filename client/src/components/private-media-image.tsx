import { useEffect, useState, useSyncExternalStore } from 'react';
import { getCookie } from 'typescript-cookie';
import type { Element, Root, RootContent } from 'hast';
import { fetchPrivateMedia, parsePrivateMediaReference, PrivateMediaUnavailable } from '../utils/private-media';

export type PrivateMediaContext = { token: string; feedId?: number; allowStaged?: boolean };

type ImagePosition = { start: { offset?: number }; end: { offset?: number } };
const maxInlineLength = 240 + '![](private-media:)'.length + 36;
const inlineImageReference = /!\[[^\[\]\r\n]{0,240}\]\((private-media:[0-9a-f-]{36})\)/g;

export function privateMediaIdFromImage(content: string, position?: ImagePosition) {
  const start = position?.start.offset;
  const end = position?.end.offset;
  if (start === undefined || end === undefined || end - start > maxInlineLength || !content.startsWith('![', start)) return null;
  const raw = content.slice(start, end);
  const match = raw.matchAll(inlineImageReference).next().value;
  return match?.[0] === raw ? parsePrivateMediaReference(match[1]) : null;
}

export function markPrivateMediaPreviews(content: string) {
  return () => (tree: Root) => {
    const ids = new Set<string>();
    const pending: Array<Root | RootContent> = [tree];
    while (pending.length && ids.size < 20) {
      const node = pending.pop()!;
      if (node.type === 'element' && node.tagName === 'img') {
        const id = privateMediaIdFromImage(content, node.position);
        if (!id || ids.has(id)) continue;
        ids.add(id);
        const data = { ...node.data, privateMediaPreview: true };
        node.data = data;
      } else if ('children' in node) {
        for (let index = node.children.length - 1; index >= 0; index--) pending.push(node.children[index]);
      }
    }
  };
}

export function isPrivateMediaPreview(node?: Element) {
  return (node?.data as { privateMediaPreview?: boolean } | undefined)?.privateMediaPreview === true;
}

const readToken = () => getCookie('token');
const emptyToken = () => undefined;
const ignoreToken = () => () => undefined;

function subscribeToToken(onChange: () => void) {
  const cookieStore = (window as Window & { cookieStore?: EventTarget }).cookieStore;
  cookieStore?.addEventListener('change', onChange);
  window.addEventListener('focus', onChange);
  window.addEventListener('pageshow', onChange);
  window.addEventListener('storage', onChange);
  document.addEventListener('visibilitychange', onChange);
  return () => {
    cookieStore?.removeEventListener('change', onChange);
    window.removeEventListener('focus', onChange);
    window.removeEventListener('pageshow', onChange);
    window.removeEventListener('storage', onChange);
    document.removeEventListener('visibilitychange', onChange);
  };
}

export function usePrivateMediaSession(enabled = true) {
  return useSyncExternalStore(enabled ? subscribeToToken : ignoreToken, enabled ? readToken : emptyToken, emptyToken);
}

export function PrivateMediaImage({ id, token, feedId, allowStaged, alt, rounded, scale }: PrivateMediaContext & {
  id: string;
  alt?: string;
  rounded: boolean;
  scale: string;
}) {
  const [result, setResult] = useState<PrivateMediaContext & { id: string; url?: string }>();
  const current = result?.id === id && result.token === token && result.feedId === feedId && result.allowStaged === allowStaged ? result : undefined;

  useEffect(() => {
    if (getCookie('token') !== token) return;
    const abort = new AbortController();
    const { signal } = abort;
    const stillCurrent = () => !signal.aborted && getCookie('token') === token;
    let url: string | undefined;
    setResult(undefined);
    const load = async () => {
      try {
        let image: Blob;
        try {
          image = await fetchPrivateMedia(id, allowStaged ? undefined : feedId, signal);
        } catch (error) {
          if (!stillCurrent() || !allowStaged || feedId === undefined || !(error instanceof PrivateMediaUnavailable)) throw error;
          image = await fetchPrivateMedia(id, feedId, signal);
        }
        if (!stillCurrent()) return;
        url = URL.createObjectURL(image);
        setResult({ id, token, feedId, allowStaged, url });
      } catch {
        if (stillCurrent()) setResult({ id, token, feedId, allowStaged });
      }
    };
    void load();
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, token, feedId, allowStaged]);

  if (!current?.url) {
    return <span className="text-sm t-secondary" role="status">{current ? '私密图片暂不可用' : '正在加载私密图片…'}</span>;
  }

  return <img src={current.url} alt={alt ?? ''} className={`mx-auto ${rounded ? 'rounded-xl' : ''}`} style={{ zoom: scale }} />;
}
