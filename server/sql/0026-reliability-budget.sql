-- Additive only: no content, reading state or offline identity changes.
CREATE TABLE IF NOT EXISTS rss_write_budget (
  day TEXT PRIMARY KEY,
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0)
);
CREATE INDEX IF NOT EXISTS visits_feed_ip ON visits(feed_id,ip);
ALTER TABLE life_daily_notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
