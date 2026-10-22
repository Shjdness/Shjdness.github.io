import type { D1Database } from '@cloudflare/workers-types';

export async function rssStorage(db: D1Database, ownerId?: number) {
  const where = ownerId ? ' WHERE owner_id=?' : '';
  const query = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(title AS BLOB))+length(CAST(url AS BLOB))+length(CAST(summary AS BLOB))+length(CAST(author AS BLOB))+length(CAST(embed_url AS BLOB))+length(CAST(thumbnail_url AS BLOB))+length(CAST(external_id AS BLOB))),0) AS bytes FROM rss_items${where}`);
  const sample = await (ownerId ? query.bind(ownerId) : query).all<{ count: number; bytes: number }>();
  const statement = db.prepare(`SELECT kind,SUM(added) AS added,SUM(updated) AS updated,SUM(unchanged) AS unchanged,SUM(rows_read) AS rowsRead,SUM(rows_written) AS rowsWritten,MIN(size_before) AS sizeBefore,MAX(size_after) AS sizeAfter FROM rss_sync_runs WHERE created_at>=?${ownerId ? ' AND owner_id=?' : ''} GROUP BY kind`);
  const since = Math.floor(Date.now() / 1000) - 86400;
  const metrics = await (ownerId ? statement.bind(since, ownerId) : statement.bind(since)).all();
  return {
    backend: { usedBytes: Number(sample.meta.size_after || 0), limitBytes: null, measured: Boolean(sample.meta.size_after), scope: 'entire-database' },
    rssBytes: Number(sample.results[0]?.bytes || 0), items: Number(sample.results[0]?.count || 0),
    metrics: metrics.results, measuredAt: new Date().toISOString(),
    measurement: 'D1 meta.size_after; RSS text fields are UTF-8 bytes, excluding row/index overhead; 24h ingestion queries exclude monitoring/subscription writes. Database quota depends on the Cloudflare plan.',
  };
}
