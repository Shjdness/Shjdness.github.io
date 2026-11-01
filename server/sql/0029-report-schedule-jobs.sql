-- Operational queues are not personal backup data and must not be replayed on restore.
CREATE TABLE IF NOT EXISTS life_report_jobs (
  job_key text PRIMARY KEY NOT NULL CHECK(length(job_key)=64),
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('daily','weekly')),
  period_start integer NOT NULL,
  period_end integer NOT NULL CHECK(period_end>period_start),
  anchor_at integer NOT NULL,
  include_daily integer NOT NULL CHECK(include_daily IN (0,1) AND (include_daily=0 OR kind='weekly')),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','generating','ready','paused','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  lease_token text,
  lease_until integer,
  next_attempt_at integer NOT NULL DEFAULT 0,
  report_id integer REFERENCES life_reports(id),
  daily_report_id integer REFERENCES life_reports(id),
  error_code text CHECK(error_code IN ('disabled','generation-unavailable','write-budget','invalid-job')),
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch()),
  CHECK((state='generating' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
     OR (state<>'generating' AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK(state<>'ready' OR (report_id IS NOT NULL AND (include_daily=0 OR daily_report_id IS NOT NULL)))
);
CREATE UNIQUE INDEX IF NOT EXISTS life_report_jobs_owner_period ON life_report_jobs(owner_id,kind,period_start,period_end);
CREATE INDEX IF NOT EXISTS life_report_jobs_due ON life_report_jobs(state,next_attempt_at,lease_until);
CREATE INDEX IF NOT EXISTS life_report_jobs_owner_created ON life_report_jobs(owner_id,created_at DESC,job_key);
CREATE INDEX IF NOT EXISTS life_report_preferences_active ON life_report_preferences(owner_id)
WHERE daily_enabled=1 OR weekly_enabled=1;
CREATE TABLE IF NOT EXISTS life_report_scheduler_state (
  id integer PRIMARY KEY NOT NULL CHECK(id=1),
  owner_cursor integer NOT NULL DEFAULT 0 CHECK(owner_cursor>=0)
);
INSERT INTO info(key,value) VALUES('migration_version','29')
ON CONFLICT(key) DO UPDATE SET value='29';
