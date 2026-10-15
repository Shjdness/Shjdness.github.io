"""Exercise the incident migration against a realistic split identity."""

import pathlib
import sqlite3


script = pathlib.Path(__file__).parents[1] / "0021-restore-owner-identity.sql"
db = sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE users (id INTEGER PRIMARY KEY, openid TEXT, permission INTEGER);
CREATE TABLE feeds (id INTEGER PRIMARY KEY, uid INTEGER, kind TEXT);
CREATE TABLE info (key TEXT UNIQUE, value TEXT);
INSERT INTO users VALUES (1, '121328491.0', 1), (7, '121328491', 1);
INSERT INTO feeds VALUES (10, 1, 'diary'), (11, 7, 'diary');
""")

db.executescript(script.read_text(encoding="utf-8"))
assert db.execute("SELECT id, openid, permission FROM users ORDER BY id").fetchall() == [
    (1, "121328491", 1), (7, "merged:github:121328491:7", 0)
]
assert db.execute("SELECT id, uid FROM feeds ORDER BY id").fetchall() == [(10, 1), (11, 1)]
assert db.execute("SELECT value FROM info WHERE key='migration_version'").fetchone() == ("21",)

# A retry must not duplicate, move, or remove the preserved records.
db.executescript(script.read_text(encoding="utf-8"))
assert db.execute("SELECT COUNT(*) FROM feeds WHERE uid=1").fetchone() == (2,)
print("owner repair migration: pass")
