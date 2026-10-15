"""Migration 0023 keeps old associations and separates owner-scoped tag choices."""

from pathlib import Path
import sqlite3


connection = sqlite3.connect(":memory:")
connection.execute("PRAGMA foreign_keys = ON")
connection.executescript("""
CREATE TABLE users (id integer PRIMARY KEY);
CREATE TABLE feeds (id integer PRIMARY KEY, uid integer NOT NULL, kind text NOT NULL);
CREATE TABLE hashtags (id integer PRIMARY KEY, name text NOT NULL);
CREATE TABLE feed_hashtags (feed_id integer NOT NULL, hashtag_id integer NOT NULL);
CREATE TABLE info (key text PRIMARY KEY, value text NOT NULL);
INSERT INTO users VALUES (1), (2);
INSERT INTO feeds VALUES (1, 1, 'article'), (2, 1, 'essay'),
  (3, 1, 'diary'), (4, 1, 'memo'), (5, 2, 'diary');
INSERT INTO hashtags VALUES (1, 'shared'), (2, 'private');
INSERT INTO feed_hashtags VALUES (1, 1), (2, 1), (3, 1), (4, 2), (5, 1);
""")

sql_path = Path(__file__).resolve().parents[1] / "0023-writing-tag-options.sql"
migration = sql_path.read_text(encoding="utf-8")
before = connection.execute("SELECT COUNT(*) FROM feed_hashtags").fetchone()[0]
connection.executescript(migration)
expected = {
    (1, "blog", "shared"),
    (1, "diary", "shared"),
    (1, "memo", "private"),
    (2, "diary", "shared"),
}
assert set(connection.execute("SELECT owner_id, scope, name FROM writing_tag_options")) == expected
assert connection.execute("SELECT COUNT(*) FROM feed_hashtags").fetchone()[0] == before
assert connection.execute("SELECT value FROM info WHERE key='migration_version'").fetchone() == ("23",)
connection.executescript(migration)
assert set(connection.execute("SELECT owner_id, scope, name FROM writing_tag_options")) == expected

try:
    connection.execute("INSERT INTO writing_tag_options (owner_id, scope, name) VALUES (1, 'blog', 'shared')")
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Duplicate owner and scope tag was accepted")

print("Migration 0023 retained associations and separated owner and writing scope")
