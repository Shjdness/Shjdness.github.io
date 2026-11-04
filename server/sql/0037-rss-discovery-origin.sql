-- Preserve the first observed import path. Old rows remain explicitly unknown;
-- neither published_at nor an aggregate sync log proves their origin.
ALTER TABLE rss_items ADD COLUMN discovery_kind TEXT NOT NULL DEFAULT 'legacy'
 CHECK(discovery_kind IN ('legacy','feed','push','history','fallback'));
CREATE INDEX IF NOT EXISTS rss_items_owner_discovered ON rss_items(owner_id,created_at);
INSERT INTO info(key,value) VALUES('migration_version','37') ON CONFLICT(key) DO UPDATE SET value='37';
