ALTER TABLE feeds ADD COLUMN kind TEXT NOT NULL DEFAULT 'article';

UPDATE feeds
SET kind = 'diary', draft = 0, listed = 0
WHERE id IN (
  SELECT fh.feed_id
  FROM feed_hashtags fh
  JOIN hashtags h ON h.id = fh.hashtag_id
  WHERE h.name = '日记'
);

DELETE FROM feed_hashtags
WHERE hashtag_id IN (SELECT id FROM hashtags WHERE name = '日记');
DELETE FROM hashtags WHERE name = '日记';

-- RSS is now a YouTube-only reader. Remove old bridge subscriptions and their entries.
DELETE FROM rss_items
WHERE subscription_id IN (
  SELECT id FROM rss_subscriptions
  WHERE feed_url NOT LIKE '%youtube.com/feeds/videos.xml%'
    AND source_url NOT LIKE '%youtube.com/%'
    AND source_url NOT LIKE '%youtu.be/%'
);
DELETE FROM rss_subscriptions
WHERE feed_url NOT LIKE '%youtube.com/feeds/videos.xml%'
  AND source_url NOT LIKE '%youtube.com/%'
  AND source_url NOT LIKE '%youtu.be/%';
UPDATE rss_subscriptions
SET platform = 'youtube', provider = 'native', content_type = 'video', last_error = '';
DELETE FROM rss_source_groups
WHERE name NOT IN (SELECT DISTINCT category FROM rss_subscriptions);

ALTER TABLE rss_subscriptions ADD COLUMN websub_key TEXT NOT NULL DEFAULT '';
ALTER TABLE rss_subscriptions ADD COLUMN websub_callback TEXT NOT NULL DEFAULT '';
ALTER TABLE rss_subscriptions ADD COLUMN websub_lease_expires_at INTEGER;

-- Keep one canonical Today item for each owner/date/content combination.
DELETE FROM daily_basics
WHERE id NOT IN (
  SELECT MIN(id)
  FROM daily_basics
  GROUP BY owner_id, date, lower(trim(content))
);
