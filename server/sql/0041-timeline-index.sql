CREATE INDEX IF NOT EXISTS feeds_public_timeline
ON feeds(draft, listed, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS feed_hashtags_feed_tag
ON feed_hashtags(feed_id, hashtag_id);
