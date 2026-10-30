"""Additive reliability migration preserves existing notes and visit records."""
import sqlite3
from pathlib import Path

db = sqlite3.connect(':memory:')
db.executescript('''
CREATE TABLE life_daily_notes(id INTEGER PRIMARY KEY,owner_id INTEGER,date TEXT,content TEXT,updated_at INTEGER);
CREATE TABLE visits(id INTEGER PRIMARY KEY,feed_id INTEGER,ip TEXT);
INSERT INTO life_daily_notes VALUES(1,1,'2026-10-30','original local text',100),(2,2,'2026-10-30','another owner',101);
INSERT INTO visits VALUES(1,3,'test-only');
''')
notes = db.execute('SELECT * FROM life_daily_notes ORDER BY id').fetchall()
visits = db.execute('SELECT * FROM visits').fetchall()
db.executescript((Path(__file__).resolve().parents[1]/'0026-reliability-budget.sql').read_text(encoding='utf-8'))
assert db.execute('SELECT id,owner_id,date,content,updated_at FROM life_daily_notes ORDER BY id').fetchall() == notes
assert db.execute('SELECT revision FROM life_daily_notes').fetchall() == [(0,), (0,)]
assert db.execute('SELECT * FROM visits').fetchall() == visits
assert 'visits_feed_ip' in [row[1] for row in db.execute('PRAGMA index_list(visits)')]
print('Reliability migration: note contents, owners and visits preserved; revision initialized')
