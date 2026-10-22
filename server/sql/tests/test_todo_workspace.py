"""Upgrade real legacy todo rows without changing their identities or content."""
from pathlib import Path
import sqlite3
import time

db = sqlite3.connect(':memory:')
db.executescript('CREATE TABLE users(id INTEGER PRIMARY KEY); CREATE TABLE info(key TEXT PRIMARY KEY,value TEXT); INSERT INTO users VALUES(1),(2);')
root = Path(__file__).resolve().parents[1]
db.executescript((root / '0018-life-todos.sql').read_text(encoding='utf-8'))
db.executemany('INSERT INTO life_todos(id,owner_id,content,type,completed,client_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [
    (10,1,'old task','task',0,'key-10',100,200),
    (11,1,'old idea','learn',0,'key-11',100,201),
    (12,2,'completed task','task',1,'key-12',100,202),
    (13,2,'completed learning','learn',1,'key-13',100,203),
])
before = db.execute('SELECT * FROM life_todos ORDER BY id').fetchall()
started = int(time.time())
db.executescript((root / '0024-todo-workspace.sql').read_text(encoding='utf-8'))
after = db.execute('SELECT id,owner_id,content,type,completed,client_key,created_at,updated_at FROM life_todos ORDER BY id').fetchall()
assert after == before, 'Legacy rows changed'
deadline, completed, order = db.execute('SELECT deadline_at,completed_at,sort_order FROM life_todos WHERE id=10').fetchone()
assert started + 259200 <= deadline <= int(time.time()) + 259200
assert completed is None and order == 0
assert db.execute('SELECT deadline_at FROM life_todos WHERE id=11').fetchone() == (None,)
assert db.execute('SELECT completed_at FROM life_todos WHERE id=12').fetchone() == (202,)
assert db.execute('SELECT completed_at FROM life_todos WHERE id=13').fetchone() == (203,)
assert db.execute("SELECT value FROM info WHERE key='migration_version'").fetchone() == ('24',)
print('Migration 0024 preserved identities, owners, history and fresh 72-hour windows')
