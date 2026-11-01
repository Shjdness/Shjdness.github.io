-- New encrypted recipient configuration and operational proof; no old content rewrites.
CREATE TABLE IF NOT EXISTS life_report_mail_contacts (
  owner_id integer PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_sealed text NOT NULL CHECK(length(email_sealed)<=2048),
  fingerprint text NOT NULL CHECK(length(fingerprint)=64),
  revision integer NOT NULL CHECK(revision>=1),
  verified_at integer,
  enabled_at integer,
  paused_reason text CHECK(paused_reason IN ('bounced','complained')),
  updated_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS life_report_mail_deliveries (
  delivery_key text PRIMARY KEY NOT NULL CHECK(length(delivery_key)=64),
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('verification','report')),
  purpose_key text NOT NULL CHECK(length(purpose_key)<=256),
  job_key text REFERENCES life_report_jobs(job_key),
  contact_revision integer NOT NULL CHECK(contact_revision>=1),
  fingerprint text NOT NULL CHECK(length(fingerprint)=64),
  provider_identity text NOT NULL CHECK(length(provider_identity) BETWEEN 1 AND 64),
  provider_id text CHECK(length(provider_id)<=256),
  state text NOT NULL CHECK(state IN ('queued','submitting','accepted','delivered','rejected','unknown','bounced','complained','paused')),
  message_json text CHECK(length(message_json)<=16384),
  message_sha256 text NOT NULL CHECK(length(message_sha256)=64),
  error_code text CHECK(error_code IN ('unavailable','rejected','recipient-changed','disabled','configuration-changed')),
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CHECK((kind='verification' AND job_key IS NULL AND message_json IS NULL) OR (kind='report' AND job_key IS NOT NULL AND message_json IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS life_report_mail_purpose ON life_report_mail_deliveries(owner_id,kind,purpose_key);
CREATE UNIQUE INDEX IF NOT EXISTS life_report_mail_provider_id ON life_report_mail_deliveries(provider_identity,provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS life_report_mail_owner_created ON life_report_mail_deliveries(owner_id,created_at DESC,delivery_key);
CREATE INDEX IF NOT EXISTS life_report_mail_pending ON life_report_mail_deliveries(state,created_at);
CREATE INDEX IF NOT EXISTS life_report_jobs_mail_ready ON life_report_jobs(state,anchor_at,job_key);
CREATE TABLE IF NOT EXISTS life_report_mail_scheduler_state (
  id integer PRIMARY KEY CHECK(id=1),
  after_anchor integer NOT NULL,
  after_key text NOT NULL CHECK(length(after_key)=64)
);
-- A crash after the single-owner slot claim must not create a second verification send.
CREATE TABLE IF NOT EXISTS life_report_mail_verification_slots (
  owner_id integer PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_revision integer NOT NULL,
  delivery_key text NOT NULL CHECK(length(delivery_key)=64),
  expires_at integer NOT NULL
);
CREATE TABLE IF NOT EXISTS life_report_mail_verifications (
  token_hash text PRIMARY KEY NOT NULL CHECK(length(token_hash)=64),
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_revision integer NOT NULL,
  fingerprint text NOT NULL CHECK(length(fingerprint)=64),
  delivery_key text NOT NULL REFERENCES life_report_mail_deliveries(delivery_key),
  created_at integer NOT NULL,
  expires_at integer NOT NULL CHECK(expires_at>created_at),
  used_at integer
);
CREATE INDEX IF NOT EXISTS life_report_mail_verify_owner ON life_report_mail_verifications(owner_id,contact_revision,expires_at);
CREATE TABLE IF NOT EXISTS life_report_mail_budget (
  bucket text PRIMARY KEY NOT NULL,
  reserved integer NOT NULL DEFAULT 0 CHECK(reserved BETWEEN 0 AND 100)
);
CREATE TABLE IF NOT EXISTS life_report_mail_admissions (
  request_key text PRIMARY KEY NOT NULL CHECK(length(request_key)=64),
  owner_bucket text NOT NULL REFERENCES life_report_mail_budget(bucket),
  global_bucket text NOT NULL REFERENCES life_report_mail_budget(bucket),
  created_at integer NOT NULL
);
CREATE TABLE IF NOT EXISTS life_report_mail_events (
  event_id text PRIMARY KEY NOT NULL CHECK(length(event_id)<=128),
  delivery_key text NOT NULL REFERENCES life_report_mail_deliveries(delivery_key),
  status text NOT NULL CHECK(status IN ('accepted','delivered','rejected','bounced','complained')),
  event_sha256 text NOT NULL CHECK(length(event_sha256)=64),
  created_at integer NOT NULL
);
INSERT INTO info(key,value) VALUES('migration_version','30')
ON CONFLICT(key) DO UPDATE SET value='30';
