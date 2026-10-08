-- Collapse every historical copy of the same YouTube video. Some legacy rows
-- used a non-canonical external_id, so the watch URL is also treated as truth.
UPDATE rss_items
SET
  read = (SELECT MAX(copy.read) FROM rss_items copy WHERE copy.owner_id = rss_items.owner_id AND copy.external_id = rss_items.external_id),
  starred = (SELECT MAX(copy.starred) FROM rss_items copy WHERE copy.owner_id = rss_items.owner_id AND copy.external_id = rss_items.external_id),
  read_at = (SELECT MAX(copy.read_at) FROM rss_items copy WHERE copy.owner_id = rss_items.owner_id AND copy.external_id = rss_items.external_id),
  starred_at = (SELECT MAX(copy.starred_at) FROM rss_items copy WHERE copy.owner_id = rss_items.owner_id AND copy.external_id = rss_items.external_id)
WHERE external_id <> '' AND id IN (SELECT MIN(id) FROM rss_items WHERE external_id <> '' GROUP BY owner_id, external_id);

DELETE FROM rss_items
WHERE external_id <> '' AND id NOT IN (
  SELECT MIN(id) FROM rss_items WHERE external_id <> '' GROUP BY owner_id, external_id
);

UPDATE rss_items
SET
  read = (SELECT MAX(copy.read) FROM rss_items copy WHERE copy.owner_id = rss_items.owner_id AND (copy.external_id = rss_items.external_id OR copy.url = rss_items.url)),
  starred = (SELECT MAX(copy.starred) FROM rss_items copy WHERE copy.owner_id = rss_items.owner_id AND (copy.external_id = rss_items.external_id OR copy.url = rss_items.url)),
  read_at = (SELECT MAX(copy.read_at) FROM rss_items copy WHERE copy.owner_id = rss_items.owner_id AND (copy.external_id = rss_items.external_id OR copy.url = rss_items.url)),
  starred_at = (SELECT MAX(copy.starred_at) FROM rss_items copy WHERE copy.owner_id = rss_items.owner_id AND (copy.external_id = rss_items.external_id OR copy.url = rss_items.url))
WHERE id IN (SELECT MIN(id) FROM rss_items GROUP BY owner_id, url);

DELETE FROM rss_items
WHERE id NOT IN (SELECT MIN(id) FROM rss_items GROUP BY owner_id, url);

-- Channel duplicates can survive old imports when external_id was blank. Move
-- their remaining videos onto one subscription, then remove empty copies.
UPDATE rss_items
SET subscription_id = (
  SELECT MIN(candidate.id)
  FROM rss_subscriptions current
  JOIN rss_subscriptions candidate
    ON candidate.owner_id = current.owner_id
   AND candidate.feed_url = current.feed_url
  WHERE current.id = rss_items.subscription_id
)
WHERE subscription_id IN (SELECT id FROM rss_subscriptions WHERE platform = 'youtube');

DELETE FROM rss_subscriptions
WHERE platform = 'youtube'
  AND id NOT IN (
    SELECT MIN(id) FROM rss_subscriptions
    WHERE platform = 'youtube'
    GROUP BY owner_id, feed_url
  );

DELETE FROM rss_source_groups
WHERE name NOT IN (SELECT DISTINCT category FROM rss_subscriptions);

INSERT INTO info (key, value) VALUES ('migration_version', '19')
ON CONFLICT(key) DO UPDATE SET value = '19';
