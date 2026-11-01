-- Operational opt-in proof, not restored from personal backups.
CREATE TABLE IF NOT EXISTS life_report_ai_consent (
  owner_id integer PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled_at integer,
  scope_version integer NOT NULL DEFAULT 1 CHECK(scope_version=1)
);
CREATE TABLE IF NOT EXISTS life_report_ai_scheduler_state (
  id integer PRIMARY KEY CHECK(id=1),
  after_anchor integer NOT NULL,
  after_key text NOT NULL CHECK(length(after_key)=64)
);
INSERT INTO info(key,value) VALUES('migration_version','31')
ON CONFLICT(key) DO UPDATE SET value='31';
