-- Independent persistent approval for selected habit/checkin/diet/routine AI.
-- Never exported/restored as personal data; old numeric consent is unchanged.
CREATE TABLE IF NOT EXISTS life_report_selected_ai_consent (
 owner_id INTEGER PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 scope_version INTEGER NOT NULL DEFAULT 2 CHECK(scope_version=2),
 enabled_at INTEGER,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS life_report_selected_ai_scheduler_state (
 id INTEGER PRIMARY KEY CHECK(id=1),
 after_anchor INTEGER NOT NULL DEFAULT 0,
 after_key TEXT NOT NULL DEFAULT ''
);
INSERT INTO info(key,value) VALUES('migration_version','40') ON CONFLICT(key) DO UPDATE SET value='40';
