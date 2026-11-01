-- Additive only: no rewrites of existing Life records or offline identities.
CREATE TABLE IF NOT EXISTS life_report_preferences (
  owner_id integer PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai' CHECK(length(timezone) BETWEEN 1 AND 64),
  daily_time text NOT NULL DEFAULT '08:00' CHECK(daily_time GLOB '[0-2][0-9]:[0-5][0-9]' AND daily_time<'24:00'),
  weekly_time text NOT NULL DEFAULT '08:00' CHECK(weekly_time GLOB '[0-2][0-9]:[0-5][0-9]' AND weekly_time<'24:00'),
  weekly_day integer NOT NULL DEFAULT 1 CHECK(weekly_day BETWEEN 1 AND 7),
  daily_enabled integer NOT NULL DEFAULT 0 CHECK(daily_enabled IN (0,1)),
  weekly_enabled integer NOT NULL DEFAULT 0 CHECK(weekly_enabled IN (0,1)),
  email_enabled integer NOT NULL DEFAULT 0 CHECK(email_enabled IN (0,1)),
  ai_enabled integer NOT NULL DEFAULT 0 CHECK(ai_enabled IN (0,1)),
  ai_scope text NOT NULL DEFAULT 'statistics' CHECK(ai_scope='statistics'),
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  updated_at integer NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS life_reports (
  id integer PRIMARY KEY NOT NULL,
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('daily','weekly')),
  period_start integer NOT NULL,
  period_end integer NOT NULL CHECK(period_end>period_start),
  timezone text NOT NULL DEFAULT 'Asia/Shanghai' CHECK(length(timezone) BETWEEN 1 AND 64),
  template_version integer NOT NULL DEFAULT 1 CHECK(template_version>=1),
  snapshot_json text NOT NULL CHECK(length(snapshot_json)<=16384),
  snapshot_sha256 text NOT NULL CHECK(length(snapshot_sha256)=64),
  created_at integer NOT NULL DEFAULT (unixepoch())
);
-- This is a new table: the key does not merge or constrain any old user records.
CREATE UNIQUE INDEX IF NOT EXISTS life_reports_owner_period_version
ON life_reports(owner_id,kind,period_start,period_end,template_version);
CREATE INDEX IF NOT EXISTS life_reports_owner_created ON life_reports(owner_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS life_reports_owner_id ON life_reports(owner_id,id DESC);

-- Site-wide monthly admission budget. Failed/unknown calls retain reservations.
CREATE TABLE IF NOT EXISTS life_report_ai_budget (
  month text PRIMARY KEY NOT NULL,
  reserved_fen integer NOT NULL DEFAULT 0 CHECK(reserved_fen BETWEEN 0 AND 1000)
);
CREATE TABLE IF NOT EXISTS life_report_ai_reservations (
  request_key text PRIMARY KEY NOT NULL CHECK(length(request_key)=64),
  month text NOT NULL REFERENCES life_report_ai_budget(month),
  reserved_fen integer NOT NULL CHECK(reserved_fen=5),
  created_at integer NOT NULL DEFAULT (unixepoch())
);

INSERT INTO info(key,value) VALUES('migration_version','27')
ON CONFLICT(key) DO UPDATE SET value='27';
