-- Immutable sensitive extension, always created alongside a NEW v1 report.
-- No backfill of earlier reports, no change to prior AI claims or deliveries.
CREATE TABLE IF NOT EXISTS life_report_checkin_snapshots (
 report_id INTEGER PRIMARY KEY NOT NULL REFERENCES life_reports(id) ON DELETE CASCADE,
 owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 report_sha256 TEXT NOT NULL CHECK(length(report_sha256)=64),
 version INTEGER NOT NULL CHECK(version=1),
 outbound_eligible INTEGER NOT NULL DEFAULT 0 CHECK(outbound_eligible IN (0,1)),
 sealed_json TEXT NOT NULL CHECK(length(sealed_json)<=180000),
 content_hmac TEXT NOT NULL CHECK(length(content_hmac)=44),
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS life_report_checkin_owner ON life_report_checkin_snapshots(owner_id,report_id);
INSERT INTO info(key,value) VALUES('migration_version','33') ON CONFLICT(key) DO UPDATE SET value='33';
