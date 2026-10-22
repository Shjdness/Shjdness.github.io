"""Migration merges identity copies without losing reading state or other owners."""
import sqlite3
from pathlib import Path
db=sqlite3.connect(':memory:')
db.executescript('''
CREATE TABLE info(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE rss_subscriptions(id INTEGER PRIMARY KEY,owner_id INTEGER,platform TEXT);
CREATE TABLE rss_items(id INTEGER PRIMARY KEY,owner_id INTEGER,subscription_id INTEGER,external_id TEXT,title TEXT,url TEXT,summary TEXT,author TEXT,embed_url TEXT,thumbnail_url TEXT,published_at INTEGER,read INTEGER,starred INTEGER,read_at INTEGER,starred_at INTEGER,created_at INTEGER,updated_at INTEGER);
INSERT INTO rss_subscriptions VALUES(1,1,'youtube'),(2,2,'youtube');
INSERT INTO rss_items VALUES(10,1,1,'yt:video:abcdefghijk','旧标题','https://youtu.be/abcdefghijk','简介','作者','','',100,0,0,NULL,NULL,1,2);
INSERT INTO rss_items VALUES(11,1,1,'abcdefghijk','旧标题','https://www.youtube.com/watch?v=abcdefghijk','简介','作者','','',100,1,1,99,98,1,3);
INSERT INTO rss_items VALUES(12,2,2,'abcdefghijk','另一个账户','https://www.youtube.com/watch?v=abcdefghijk','','','','',100,0,0,NULL,NULL,1,3);
INSERT INTO rss_items VALUES(13,1,1,'lmnopqrstuv','同名但不同视频','https://www.youtube.com/watch?v=lmnopqrstuv','','','','',101,0,0,NULL,NULL,1,3);
''')
db.executescript((Path(__file__).resolve().parents[1]/'0025-rss-history.sql').read_text(encoding='utf-8'))
assert db.execute('SELECT id,external_id,read,starred,read_at,starred_at FROM rss_items WHERE owner_id=1 ORDER BY id').fetchall()==[(10,'abcdefghijk',1,1,99,98),(13,'lmnopqrstuv',0,0,None,None)]
assert db.execute('SELECT title,read,starred FROM rss_items WHERE owner_id=2').fetchone()==('另一个账户',0,0)
assert db.execute('SELECT id,read,starred FROM rss_duplicate_archive').fetchall()==[(11,1,1)]
assert db.execute("SELECT value FROM info WHERE key='migration_version'").fetchone()==('25',)
assert db.execute("SELECT history_status FROM rss_subscriptions WHERE id=1").fetchone()==('pending',)
print('RSS migration: canonical dedupe, archive, read/star flags, distinct videos and owner isolation passed')
