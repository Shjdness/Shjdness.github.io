CREATE TABLE IF NOT EXISTS private_media_budget (
    day TEXT NOT NULL,
    scope TEXT NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts > 0),
    bytes INTEGER NOT NULL CHECK (bytes > 0),
    PRIMARY KEY (day, scope)
) WITHOUT ROWID;
