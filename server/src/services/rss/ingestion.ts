import type { D1Database } from '@cloudflare/workers-types';

export type VideoRecord = {
  externalId: string; title: string; url: string; summary: string; author: string;
  embedUrl: string; thumbnailUrl: string; publishedAt: Date; publishedPrecision?: string;
};
type Stored = { external_id: string; title: string; url: string; summary: string; author: string; embed_url: string; thumbnail_url: string; published_at: number; published_precision: string; subscription_id: number };
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const contentFields = ['title', 'url', 'summary', 'author', 'embed_url', 'thumbnail_url', 'published_at', 'published_precision'] as const;

export function videoValues(video: VideoRecord, existing?: Stored, history = false) {
  const incoming = {
    title: video.title.slice(0, 500), url: `https://www.youtube.com/watch?v=${video.externalId}`,
    summary: video.summary.slice(0, 4000), author: video.author.slice(0, 200),
    embed_url: `https://www.youtube-nocookie.com/embed/${video.externalId}`,
    thumbnail_url: `https://i.ytimg.com/vi/${video.externalId}/hqdefault.jpg`,
    published_at: Math.floor(video.publishedAt.getTime() / 1000),
    published_precision: video.publishedPrecision || 'exact',
  };
  if (!Number.isFinite(incoming.published_at)) throw Error('Invalid publication date');
  // A flat historical listing must never replace richer feed metadata or dates.
  if (history && existing) for (const key of contentFields) {
    if (key === 'published_at' || key === 'published_precision') {
      if (existing.published_precision === 'exact' || incoming.published_precision !== 'exact') (incoming as any)[key] = existing[key];
    } else if (existing[key]) incoming[key] = existing[key];
  }
  return incoming;
}

export async function ingestVideos(db: D1Database, source: { id: number; ownerId: number }, input: VideoRecord[], kind: 'feed' | 'history' | 'push' = 'feed') {
  const unique = [...new Map(input.filter(video => VIDEO_ID.test(video.externalId)).map(video => [video.externalId, video])).values()];
  if (unique.length > 30) throw Error('At most 30 videos per ingestion batch');
  const snapshot = await db.prepare('SELECT 1 AS ok').all();
  let rowsRead = Number(snapshot.meta.rows_read || 0), rowsWritten = 0;
  const stored = unique.length ? await db.prepare(`SELECT external_id,title,url,summary,author,embed_url,thumbnail_url,published_at,published_precision,subscription_id FROM rss_items WHERE owner_id=? AND external_id IN (${unique.map(() => '?').join(',')})`).bind(source.ownerId, ...unique.map(video => video.externalId)).all<Stored>() : null;
  rowsRead += Number(stored?.meta.rows_read || 0);
  const previous = new Map((stored?.results || []).map(row => [row.external_id, row]));
  let added = 0, updated = 0, unchanged = 0;
  const statements = [];
  const now = Math.floor(Date.now() / 1000);
  for (const video of unique) {
    const old = previous.get(video.externalId);
    const values = videoValues(video, old, kind === 'history');
    if (old && contentFields.every(key => old[key] === values[key])) { unchanged++; continue; }
    if (old) updated++; else added++;
    statements.push(db.prepare(`INSERT INTO rss_items (owner_id,subscription_id,external_id,${contentFields.join(',')},created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,external_id) DO UPDATE SET
      ${contentFields.map(key => `${key}=excluded.${key}`).join(',')},updated_at=excluded.updated_at
      WHERE ${contentFields.map(key => `rss_items.${key} IS NOT excluded.${key}`).join(' OR ')}`)
      .bind(source.ownerId, old?.subscription_id ?? source.id, video.externalId, ...contentFields.map(key => values[key]), now, now));
  }
  let sizeAfter = Number(snapshot.meta.size_after || 0);
  if (statements.length) for (const result of await db.batch(statements)) {
    rowsRead += Number(result.meta.rows_read || 0); rowsWritten += Number(result.meta.rows_written || 0);
    sizeAfter = Number(result.meta.size_after || sizeAfter);
  }
  // Measure the ingestion queries; monitoring's own one-row append is excluded.
  await db.prepare('INSERT INTO rss_sync_runs(owner_id,source_id,kind,added,updated,unchanged,rows_read,rows_written,size_before,size_after,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .bind(source.ownerId, source.id, kind, added, updated, unchanged, rowsRead, rowsWritten, Number(snapshot.meta.size_after || 0), sizeAfter, now).run();
  return { added, updated, unchanged, rowsRead, rowsWritten, sizeBefore: Number(snapshot.meta.size_after || 0), sizeAfter };
}
