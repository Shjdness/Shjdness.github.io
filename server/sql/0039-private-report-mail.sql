-- Private message bodies never enter the legacy plaintext message column.
-- This is an operational ledger: exclude from personal backup and restore.
CREATE TABLE IF NOT EXISTS life_report_private_messages (
 delivery_key TEXT PRIMARY KEY NOT NULL REFERENCES life_report_mail_deliveries(delivery_key) ON DELETE CASCADE,
 owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 report_id INTEGER NOT NULL REFERENCES life_reports(id) ON DELETE CASCADE,
 sealed_json TEXT NOT NULL CHECK(length(sealed_json)<=180000),
 content_hmac TEXT NOT NULL CHECK(length(content_hmac)=44)
);
CREATE INDEX IF NOT EXISTS life_report_private_messages_owner ON life_report_private_messages(owner_id,report_id);
INSERT INTO info(key,value) VALUES('migration_version','39') ON CONFLICT(key) DO UPDATE SET value='39';
