import type { RssItem } from './model';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function youtubeVideoId(item: Pick<RssItem, 'externalId' | 'url' | 'embedUrl'>): string {
  for (const value of [item.embedUrl, item.url]) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      let candidate = '';
      if (host === 'youtu.be') candidate = url.pathname.split('/')[1] || '';
      else if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com' || host === 'www.youtube-nocookie.com') {
        candidate = url.searchParams.get('v') || url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1] || '';
      }
      if (VIDEO_ID.test(candidate)) return candidate;
    } catch { /* Legacy entries can have incomplete URLs. */ }
  }
  const external = item.externalId?.replace(/^yt:video:/, '') || '';
  return VIDEO_ID.test(external) ? external : '';
}

export function dedupeRssItems(items: RssItem[]): RssItem[] {
  const seen = new Map<string, RssItem>();
  for (const item of items) {
    const key = youtubeVideoId(item) || item.url || `${item.externalId}:${item.id}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...item });
      continue;
    }
    existing.read = existing.read || item.read;
    existing.starred = existing.starred || item.starred;
    if (item.readAt && (!existing.readAt || new Date(item.readAt) > new Date(existing.readAt))) existing.readAt = item.readAt;
    if (item.starredAt && (!existing.starredAt || new Date(item.starredAt) > new Date(existing.starredAt))) existing.starredAt = item.starredAt;
  }
  return [...seen.values()];
}
