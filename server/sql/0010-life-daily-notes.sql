ALTER TABLE `habits` ADD COLUMN `client_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `habits_owner_client_key` ON `habits` (`owner_id`, `client_key`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `life_daily_notes` (
  `id` integer PRIMARY KEY NOT NULL,
  `owner_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `date` text NOT NULL,
  `content` text DEFAULT '' NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `life_daily_notes_owner_date` ON `life_daily_notes` (`owner_id`, `date`);
--> statement-breakpoint
INSERT INTO `info` (`key`, `value`) VALUES ('migration_version', '10') ON CONFLICT(`key`) DO UPDATE SET `value` = '10';
