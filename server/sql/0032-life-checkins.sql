-- Independent new personal module. Existing diary/task IDs and tables untouched.
-- Non-secret HMAC proof prevents accidental replacement keys from creating a
-- mixture of unreadable old data and new data. Never restored from personal files.
CREATE TABLE IF NOT EXISTS life_checkin_key_guard (
 id INTEGER PRIMARY KEY CHECK(id=1),
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=44)
);
CREATE TABLE IF NOT EXISTS life_checkins (
 owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 record_date TEXT NOT NULL CHECK(length(record_date)=10),
 revision INTEGER NOT NULL CHECK(revision>0),
 client_key TEXT NOT NULL CHECK(length(client_key)=36),
 sealed_json TEXT NOT NULL CHECK(length(sealed_json)<=24000),
 content_hmac TEXT NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,record_date)
);
CREATE TABLE IF NOT EXISTS life_checkin_revisions (
 owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 record_date TEXT NOT NULL,
 revision INTEGER NOT NULL,
 client_key TEXT NOT NULL,
 sealed_json TEXT NOT NULL,
 content_hmac TEXT NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,record_date,revision)
);
CREATE TRIGGER IF NOT EXISTS life_checkin_insert_revision AFTER INSERT ON life_checkins BEGIN
 INSERT INTO life_checkin_revisions VALUES(NEW.owner_id,NEW.record_date,NEW.revision,NEW.client_key,NEW.sealed_json,NEW.content_hmac,NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS life_checkin_update_revision AFTER UPDATE ON life_checkins BEGIN
 INSERT INTO life_checkin_revisions VALUES(NEW.owner_id,NEW.record_date,NEW.revision,NEW.client_key,NEW.sealed_json,NEW.content_hmac,NEW.updated_at);
 DELETE FROM life_checkin_revisions WHERE owner_id=NEW.owner_id AND record_date=NEW.record_date AND revision<=NEW.revision-10;
END;
INSERT INTO info(key,value) VALUES('migration_version','32') ON CONFLICT(key) DO UPDATE SET value='32';
