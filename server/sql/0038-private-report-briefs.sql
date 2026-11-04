-- Immutable private facts; separate from numeric AI snapshots and consent.
CREATE TABLE IF NOT EXISTS life_report_briefs (
 report_id INTEGER PRIMARY KEY NOT NULL REFERENCES life_reports(id) ON DELETE CASCADE,
 owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 report_sha256 TEXT NOT NULL CHECK(length(report_sha256)=64),
 version INTEGER NOT NULL CHECK(version=1),
 outbound_eligible INTEGER NOT NULL DEFAULT 0 CHECK(outbound_eligible IN (0,1)),
 scheduled_at INTEGER NOT NULL,
 facts_sealed TEXT NOT NULL CHECK(length(facts_sealed)<=180000),
 facts_hmac TEXT NOT NULL CHECK(length(facts_hmac)=44),
 rss_sealed TEXT CHECK(length(rss_sealed)<=180000),
 rss_hmac TEXT CHECK(length(rss_hmac)=44),
 checkin_hmac TEXT NOT NULL CHECK(length(checkin_hmac)=44),
 content_hmac TEXT NOT NULL CHECK(length(content_hmac)=44),
 created_at INTEGER NOT NULL,
 CHECK((rss_sealed IS NULL)=(rss_hmac IS NULL))
);
CREATE INDEX IF NOT EXISTS life_report_briefs_owner ON life_report_briefs(owner_id,report_id);
-- Old numeric/email consent never enables named briefs. Excluded from backup.
CREATE TABLE IF NOT EXISTS life_report_brief_consent (
 owner_id INTEGER PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 scope_version INTEGER NOT NULL DEFAULT 3 CHECK(scope_version=3),
 enabled_at INTEGER,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 updated_at INTEGER NOT NULL
);
INSERT INTO info(key,value) VALUES('migration_version','38') ON CONFLICT(key) DO UPDATE SET value='38';
