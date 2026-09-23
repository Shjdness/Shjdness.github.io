CREATE TABLE IF NOT EXISTS `daily_basics` (
  `id` integer PRIMARY KEY NOT NULL,
  `owner_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `date` text NOT NULL,
  `content` text NOT NULL,
  `completed` integer DEFAULT 0 NOT NULL,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `client_key` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `daily_basics_owner_client_key` ON `daily_basics` (`owner_id`, `client_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `daily_basics_owner_date` ON `daily_basics` (`owner_id`, `date`);
--> statement-breakpoint
INSERT INTO `info` (`key`, `value`) VALUES ('migration_version', '11') ON CONFLICT(`key`) DO UPDATE SET `value` = '11';
