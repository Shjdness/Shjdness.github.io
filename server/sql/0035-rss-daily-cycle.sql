-- Operational reconciliation state; excluded from personal backups/restores.
-- One admission per Shanghai day, independent of workflow reruns/retries.
CREATE TABLE IF NOT EXISTS rss_daily_cycles (
 day TEXT PRIMARY KEY NOT NULL CHECK(length(day)=10),
 run_key TEXT NOT NULL CHECK(length(run_key) BETWEEN 3 AND 80),
 started_at INTEGER NOT NULL,
 finished_at INTEGER,
 state TEXT NOT NULL CHECK(state IN ('running','complete','partial')),
 source_ids TEXT NOT NULL CHECK(json_valid(source_ids) AND length(source_ids)<=32768),
 expected INTEGER NOT NULL CHECK(expected BETWEEN 0 AND 5000),
 succeeded INTEGER NOT NULL DEFAULT 0 CHECK(succeeded>=0 AND succeeded<=expected),
 CHECK((state='running' AND finished_at IS NULL) OR (state!='running' AND finished_at>=started_at))
);
-- Non-replayable capture provenance. Old reports are never backfilled.
CREATE TABLE IF NOT EXISTS life_report_rss_captures (
 report_id INTEGER PRIMARY KEY NOT NULL REFERENCES life_reports(id) ON DELETE CASCADE,
 report_sha256 TEXT NOT NULL CHECK(length(report_sha256)=64),
 status_json TEXT NOT NULL CHECK(json_valid(status_json) AND length(status_json)<=1024)
);
INSERT INTO info(key,value) VALUES('migration_version','35') ON CONFLICT(key) DO UPDATE SET value='35';
