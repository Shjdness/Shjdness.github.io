-- Additive analysis ledger; never rewrite source records or prior migrations.
CREATE TABLE IF NOT EXISTS life_report_analyses (
  request_key text PRIMARY KEY NOT NULL CHECK(length(request_key)=64),
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_id integer NOT NULL REFERENCES life_reports(id) ON DELETE CASCADE,
  snapshot_sha256 text NOT NULL CHECK(length(snapshot_sha256)=64),
  model text NOT NULL CHECK(model='deepseek-flash'),
  prompt_version integer NOT NULL DEFAULT 1 CHECK(prompt_version=1),
  state text NOT NULL CHECK(state IN ('pending','succeeded','statistics','unknown')),
  reason text CHECK(reason IN ('budget-or-duplicate','unavailable','interrupted')),
  analysis_json text CHECK(length(analysis_json)<=8192),
  analysis_sha256 text CHECK(length(analysis_sha256)=64),
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch()),
  CHECK((state='succeeded' AND reason IS NULL AND analysis_json IS NOT NULL AND analysis_sha256 IS NOT NULL)
     OR (state='pending' AND reason IS NULL AND analysis_json IS NULL AND analysis_sha256 IS NULL)
     OR (state IN ('statistics','unknown') AND reason IS NOT NULL AND analysis_json IS NULL AND analysis_sha256 IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS life_report_analyses_report_model ON life_report_analyses(owner_id,report_id,model,prompt_version);
CREATE INDEX IF NOT EXISTS life_report_analyses_owner_report ON life_report_analyses(owner_id,report_id);
INSERT INTO info(key,value) VALUES('migration_version','28')
ON CONFLICT(key) DO UPDATE SET value='28';
