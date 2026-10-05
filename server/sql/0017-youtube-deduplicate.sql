-- The reader is YouTube-only. Remove any pre-cleanup bridge records first.
DELETE FROM rss_items
WHERE subscription_id IN (
  SELECT id FROM rss_subscriptions WHERE platform <> 'youtube'
);
DELETE FROM rss_subscriptions WHERE platform <> 'youtube';

-- Preserve read/star state on the oldest copy of each YouTube video.
UPDATE rss_items
SET
  read = (
    SELECT MAX(copy.read)
    FROM rss_items AS copy
    WHERE copy.owner_id = rss_items.owner_id
      AND copy.external_id = rss_items.external_id
  ),
  starred = (
    SELECT MAX(copy.starred)
    FROM rss_items AS copy
    WHERE copy.owner_id = rss_items.owner_id
      AND copy.external_id = rss_items.external_id
  ),
  read_at = (
    SELECT MAX(copy.read_at)
    FROM rss_items AS copy
    WHERE copy.owner_id = rss_items.owner_id
      AND copy.external_id = rss_items.external_id
  ),
  starred_at = (
    SELECT MAX(copy.starred_at)
    FROM rss_items AS copy
    WHERE copy.owner_id = rss_items.owner_id
      AND copy.external_id = rss_items.external_id
  )
WHERE id IN (
  SELECT MIN(id) FROM rss_items GROUP BY owner_id, external_id
);

DELETE FROM rss_items
WHERE id NOT IN (
  SELECT MIN(id) FROM rss_items GROUP BY owner_id, external_id
);

-- Move the remaining video rows to the oldest copy of each duplicated channel.
UPDATE rss_items
SET subscription_id = (
  SELECT MIN(canonical.id)
  FROM rss_subscriptions AS current
  JOIN rss_subscriptions AS canonical
    ON canonical.owner_id = current.owner_id
   AND canonical.external_id = current.external_id
  WHERE current.id = rss_items.subscription_id
    AND current.external_id <> ''
)
WHERE subscription_id IN (
  SELECT id FROM rss_subscriptions WHERE external_id <> ''
);

DELETE FROM rss_subscriptions
WHERE external_id <> ''
  AND id NOT IN (
    SELECT MIN(id)
    FROM rss_subscriptions
    WHERE external_id <> ''
    GROUP BY owner_id, external_id
  );

DELETE FROM rss_source_groups
WHERE name NOT IN (SELECT DISTINCT category FROM rss_subscriptions);

CREATE UNIQUE INDEX IF NOT EXISTS rss_subscriptions_owner_external
ON rss_subscriptions(owner_id, external_id)
WHERE external_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS rss_items_owner_external
ON rss_items(owner_id, external_id);

CREATE UNIQUE INDEX IF NOT EXISTS rss_items_subscription_external
ON rss_items(subscription_id, external_id);

-- Remove the generic multi-platform columns introduced by the retired Folo/RSSHub reader.
DROP INDEX IF EXISTS rss_items_owner_media_published;
ALTER TABLE rss_subscriptions DROP COLUMN content_type;
ALTER TABLE rss_items DROP COLUMN media_type;
ALTER TABLE rss_items DROP COLUMN media_url;
ALTER TABLE rss_items DROP COLUMN media_json;
ALTER TABLE rss_items DROP COLUMN duration;
ALTER TABLE rss_items DROP COLUMN content_html;
