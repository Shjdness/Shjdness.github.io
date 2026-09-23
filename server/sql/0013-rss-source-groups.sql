CREATE TABLE IF NOT EXISTS `rss_source_groups` (
  `id` integer PRIMARY KEY,
  `owner_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `sort_order` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS `rss_source_groups_owner_name` ON `rss_source_groups` (`owner_id`, `name`);
INSERT OR IGNORE INTO `rss_source_groups` (`owner_id`, `name`, `sort_order`)
SELECT DISTINCT `owner_id`, COALESCE(NULLIF(TRIM(`category`), ''), '其他'), 0 FROM `rss_subscriptions`;
