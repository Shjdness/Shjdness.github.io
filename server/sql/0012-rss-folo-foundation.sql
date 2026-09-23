ALTER TABLE `rss_subscriptions` ADD COLUMN `source_url` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `rss_subscriptions` ADD COLUMN `provider` text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE `rss_subscriptions` ADD COLUMN `platform` text DEFAULT 'other' NOT NULL;
--> statement-breakpoint
ALTER TABLE `rss_subscriptions` ADD COLUMN `external_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `rss_subscriptions` ADD COLUMN `alias` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `rss_subscriptions` ADD COLUMN `description` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `rss_subscriptions` ADD COLUMN `category` text DEFAULT '其他' NOT NULL;
--> statement-breakpoint
ALTER TABLE `rss_subscriptions` ADD COLUMN `content_type` text DEFAULT 'text' NOT NULL;
--> statement-breakpoint
ALTER TABLE `rss_items` ADD COLUMN `media_type` text DEFAULT 'text' NOT NULL;
--> statement-breakpoint
ALTER TABLE `rss_items` ADD COLUMN `media_url` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `rss_items` ADD COLUMN `embed_url` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `rss_items` ADD COLUMN `thumbnail_url` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `rss_items` ADD COLUMN `duration` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `rss_items` ADD COLUMN `content_html` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `rss_subscriptions` SET `source_url` = `site_url` WHERE `source_url` = '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rss_subscriptions_owner_category` ON `rss_subscriptions` (`owner_id`, `category`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rss_items_owner_media_published` ON `rss_items` (`owner_id`, `media_type`, `published_at` DESC);
--> statement-breakpoint
INSERT INTO `info` (`key`, `value`) VALUES ('migration_version', '12') ON CONFLICT(`key`) DO UPDATE SET `value` = '12';
