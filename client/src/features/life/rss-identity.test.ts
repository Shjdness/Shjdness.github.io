import { describe, expect, it } from 'vitest';
import type { RssItem } from './model';
import { dedupeRssItems, youtubeVideoId } from './rss-identity';

const video = (id: number, externalId: string, url: string, overrides: Partial<RssItem> = {}): RssItem => ({
  id, subscriptionId: 1, externalId, title: 'Same video', url, summary: '', author: '',
  publishedAt: new Date('2026-09-25'), read: 0, starred: 0,
  embedUrl: 'https://www.youtube-nocookie.com/embed/AbC_123-xyz', thumbnailUrl: '',
  ...overrides,
});

describe('RSS YouTube identity', () => {
  it('prefers the actual video ID over legacy external IDs and URL tracking parameters', () => {
    expect(youtubeVideoId(video(1, 'legacy-one', 'https://www.youtube.com/watch?v=AbC_123-xyz&t=2'))).toBe('AbC_123-xyz');
    expect(youtubeVideoId(video(2, 'yt:video:AbC_123-xyz', 'https://youtu.be/AbC_123-xyz'))).toBe('AbC_123-xyz');
  });

  it('shows one video and retains read and starred state from both historical rows', () => {
    const result = dedupeRssItems([
      video(1, 'legacy-one', 'https://www.youtube.com/watch?v=AbC_123-xyz', { read: 1 }),
      video(2, 'legacy-two', 'https://youtu.be/AbC_123-xyz', { starred: 1 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 1, read: 1, starred: 1 });
  });
});
