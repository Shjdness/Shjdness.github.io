"""Apply migration 0022 to an old SQLite shape and check retained history."""

from pathlib import Path
import sqlite3


connection = sqlite3.connect(":memory:")
connection.execute("PRAGMA foreign_keys = ON")
connection.executescript("""
CREATE TABLE users (id integer PRIMARY KEY);
CREATE TABLE info (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE life_todos (id integer PRIMARY KEY, owner_id integer NOT NULL);
CREATE TABLE pomodoro_sessions (
  id integer PRIMARY KEY, owner_id integer NOT NULL, started_at integer NOT NULL,
  ended_at integer NOT NULL, focus_minutes integer NOT NULL, break_minutes integer NOT NULL,
  round_index integer NOT NULL, completed integer NOT NULL, task_name text NOT NULL,
  completed_early integer NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL
);
INSERT INTO users VALUES (1);
INSERT INTO life_todos VALUES (10, 1);
INSERT INTO pomodoro_sessions VALUES (100, 1, 1, 2, 25, 5, 1, 1, '旧记录', 0, 1, 1);
""")
sql_path = Path(__file__).resolve().parents[1] / "0022-pomodoro-todo-link.sql"
connection.executescript(sql_path.read_text(encoding="utf-8"))

assert connection.execute("SELECT task_name, todo_id FROM pomodoro_sessions WHERE id = 100").fetchone() == ("旧记录", None)
connection.execute("INSERT INTO pomodoro_sessions VALUES (101, 1, 3, 4, 25, 5, 1, 1, '关联任务', 0, 1, 1, 10, 'focus-101')")
try:
    connection.execute("INSERT INTO pomodoro_sessions VALUES (102, 1, 5, 6, 25, 5, 1, 1, '重复', 0, 1, 1, 10, 'focus-101')")
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Duplicate client key was accepted")
connection.execute("DELETE FROM life_todos WHERE id = 10")
assert connection.execute("SELECT todo_id, task_name FROM pomodoro_sessions WHERE id = 101").fetchone() == (None, "关联任务")
assert connection.execute("SELECT value FROM info WHERE key = 'migration_version'").fetchone() == ("22",)
print("Migration 0022 retained history, deduplicated retries and unlinked deleted todos")
