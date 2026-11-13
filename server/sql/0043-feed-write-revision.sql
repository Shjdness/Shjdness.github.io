-- Legacy rows begin at NULL. New records and updates get a fresh opaque revision.
ALTER TABLE feeds ADD COLUMN write_revision TEXT;
