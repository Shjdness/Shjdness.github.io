-- New scope2 result ledger. Existing numeric results/unknown claims untouched.
CREATE TABLE IF NOT EXISTS life_report_checkin_analyses (
 request_key TEXT PRIMARY KEY NOT NULL CHECK(length(request_key)=64),
 owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 report_id INTEGER NOT NULL REFERENCES life_reports(id) ON DELETE CASCADE,
 report_sha256 TEXT NOT NULL CHECK(length(report_sha256)=64),
 snapshot_hmac TEXT NOT NULL CHECK(length(snapshot_hmac)=44),
 scope_version INTEGER NOT NULL CHECK(scope_version=2),
 claim_token TEXT NOT NULL CHECK(length(claim_token)=36),
 state TEXT NOT NULL CHECK(state IN ('pending','succeeded','statistics','unknown')),
 reason TEXT CHECK(reason IN ('budget-or-scope','unavailable','interrupted')),
 sealed_json TEXT CHECK(length(sealed_json)<=32768),
 result_hmac TEXT CHECK(length(result_hmac)=44),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK((state='succeeded' AND reason IS NULL AND sealed_json IS NOT NULL AND result_hmac IS NOT NULL)
 OR (state='pending' AND reason IS NULL AND sealed_json IS NULL AND result_hmac IS NULL)
 OR (state IN ('statistics','unknown') AND reason IS NOT NULL AND sealed_json IS NULL AND result_hmac IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS life_report_checkin_analysis_owner ON life_report_checkin_analyses(owner_id,report_id);
INSERT INTO info(key,value) VALUES('migration_version','34') ON CONFLICT(key) DO UPDATE SET value='34';
