CREATE TABLE IF NOT EXISTS `writing_tag_options` (
  `id` integer PRIMARY KEY,
  `owner_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `scope` text NOT NULL CHECK (`scope` IN ('blog', 'diary', 'memo')),
  `name` text NOT NULL,
  `created_at` integer NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS `writing_tag_options_owner_scope_name`
ON `writing_tag_options` (`owner_id`, `scope`, `name`);

INSERT OR IGNORE INTO `writing_tag_options` (`owner_id`, `scope`, `name`)
SELECT DISTINCT f.`uid`, CASE WHEN f.`kind` IN ('article', 'essay') THEN 'blog' ELSE f.`kind` END, h.`name`
FROM `feeds` f
JOIN `feed_hashtags` fh ON fh.`feed_id` = f.`id`
JOIN `hashtags` h ON h.`id` = fh.`hashtag_id`
WHERE f.`kind` IN ('article', 'essay', 'diary', 'memo') AND trim(h.`name`) <> '';

INSERT INTO `info` (`key`, `value`) VALUES ('migration_version', '23')
ON CONFLICT(`key`) DO UPDATE SET `value` = '23';
