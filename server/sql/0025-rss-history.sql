-- Additive history metadata. Content and read/starred flags are preserved.
ALTER TABLE rss_items ADD COLUMN published_precision TEXT DEFAULT 'exact' NOT NULL;
ALTER TABLE rss_subscriptions ADD COLUMN history_policy TEXT DEFAULT '' NOT NULL;
ALTER TABLE rss_subscriptions ADD COLUMN history_reason TEXT DEFAULT '' NOT NULL;
ALTER TABLE rss_subscriptions ADD COLUMN history_status TEXT DEFAULT 'pending' NOT NULL;
ALTER TABLE rss_subscriptions ADD COLUMN history_checked_at INTEGER;
ALTER TABLE rss_subscriptions ADD COLUMN history_error TEXT DEFAULT '' NOT NULL;
CREATE TABLE rss_sync_runs (
 id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, source_id INTEGER NOT NULL,
 kind TEXT NOT NULL, added INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0,
 unchanged INTEGER NOT NULL DEFAULT 0, rows_read INTEGER NOT NULL DEFAULT 0, rows_written INTEGER NOT NULL DEFAULT 0,
 size_before INTEGER NOT NULL DEFAULT 0, size_after INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX rss_sync_runs_owner_created ON rss_sync_runs(owner_id,created_at DESC);
CREATE INDEX IF NOT EXISTS rss_items_owner_source_published ON rss_items(owner_id,subscription_id,published_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS rss_items_owner_read_published ON rss_items(owner_id,read,published_at DESC);
CREATE INDEX IF NOT EXISTS rss_items_owner_starred_published ON rss_items(owner_id,starred,published_at DESC);
-- Older imports used several external_id and URL formats for one YouTube video.
-- Derive the real video ID before collapsing rows; preserve read/starred state.
CREATE TABLE IF NOT EXISTS _rss_video_identity_v25 (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  video_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS _rss_video_identity_v25_owner_video ON _rss_video_identity_v25(owner_id, video_id);
DELETE FROM _rss_video_identity_v25;
INSERT INTO _rss_video_identity_v25 (id, owner_id, video_id)
SELECT item.id, item.owner_id,
  CASE
    WHEN instr(item.embed_url, '/embed/') > 0 THEN substr(item.embed_url, instr(item.embed_url, '/embed/') + 7, 11)
    WHEN instr(item.url, 'v=') > 0 THEN substr(item.url, instr(item.url, 'v=') + 2, 11)
    WHEN instr(item.url, 'youtu.be/') > 0 THEN substr(item.url, instr(item.url, 'youtu.be/') + 9, 11)
    WHEN length(item.external_id) = 11 THEN item.external_id
    WHEN item.external_id LIKE 'yt:video:%' THEN substr(item.external_id, 10, 11)
    ELSE ''
  END
FROM rss_items item
JOIN rss_subscriptions source ON source.id = item.subscription_id
WHERE source.platform = 'youtube';
DELETE FROM _rss_video_identity_v25 WHERE length(video_id) <> 11 OR video_id GLOB '*[^A-Za-z0-9_-]*';

CREATE TABLE IF NOT EXISTS rss_duplicate_archive AS SELECT * FROM rss_items WHERE 0;
INSERT INTO rss_duplicate_archive SELECT * FROM rss_items WHERE id IN (SELECT id FROM _rss_video_identity_v25 WHERE id NOT IN (SELECT MIN(id) FROM _rss_video_identity_v25 GROUP BY owner_id,video_id));

UPDATE rss_items
SET read = (SELECT MAX(copy.read) FROM rss_items copy JOIN _rss_video_identity_v25 key ON key.id = copy.id WHERE key.owner_id = rss_items.owner_id AND key.video_id = (SELECT video_id FROM _rss_video_identity_v25 WHERE id = rss_items.id)),
    starred = (SELECT MAX(copy.starred) FROM rss_items copy JOIN _rss_video_identity_v25 key ON key.id = copy.id WHERE key.owner_id = rss_items.owner_id AND key.video_id = (SELECT video_id FROM _rss_video_identity_v25 WHERE id = rss_items.id)),
    read_at = (SELECT MAX(copy.read_at) FROM rss_items copy JOIN _rss_video_identity_v25 key ON key.id = copy.id WHERE key.owner_id = rss_items.owner_id AND key.video_id = (SELECT video_id FROM _rss_video_identity_v25 WHERE id = rss_items.id)),
    starred_at = (SELECT MAX(copy.starred_at) FROM rss_items copy JOIN _rss_video_identity_v25 key ON key.id = copy.id WHERE key.owner_id = rss_items.owner_id AND key.video_id = (SELECT video_id FROM _rss_video_identity_v25 WHERE id = rss_items.id))
WHERE id IN (SELECT MIN(id) FROM _rss_video_identity_v25 GROUP BY owner_id, video_id);

DELETE FROM rss_items
WHERE id IN (
  SELECT id FROM _rss_video_identity_v25
  WHERE id NOT IN (SELECT MIN(id) FROM _rss_video_identity_v25 GROUP BY owner_id, video_id)
);

UPDATE rss_items
SET external_id = (SELECT video_id FROM _rss_video_identity_v25 WHERE id = rss_items.id)
WHERE id IN (SELECT MIN(id) FROM _rss_video_identity_v25 GROUP BY owner_id, video_id);

DROP TABLE _rss_video_identity_v25;


INSERT INTO info(key,value) VALUES('migration_version','25') ON CONFLICT(key) DO UPDATE SET value='25';
