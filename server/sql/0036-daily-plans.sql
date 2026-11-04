-- Additive only; no deletion/truncation of old plans, no new unique constraint.
ALTER TABLE daily_basics ADD COLUMN completed_at INTEGER;
ALTER TABLE daily_basics ADD COLUMN todo_id INTEGER REFERENCES life_todos(id) ON DELETE SET NULL;
ALTER TABLE daily_basics ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
-- Old completed records intentionally keep unknown actual completion time.
INSERT INTO info(key,value) VALUES('migration_version','36') ON CONFLICT(key) DO UPDATE SET value='36';
