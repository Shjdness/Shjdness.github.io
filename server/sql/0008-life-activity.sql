ALTER TABLE `rss_items` ADD COLUMN `read_at` integer;
--> statement-breakpoint
ALTER TABLE `rss_items` ADD COLUMN `starred_at` integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `habit_logs_owner_date` ON `habit_logs` (`owner_id`, `date`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rss_items_owner_read_at` ON `rss_items` (`owner_id`, `read_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rss_items_owner_starred_at` ON `rss_items` (`owner_id`, `starred_at`);
--> statement-breakpoint
INSERT INTO `info` (`key`, `value`) VALUES ('migration_version', '8') ON CONFLICT(`key`) DO UPDATE SET `value` = '8';
