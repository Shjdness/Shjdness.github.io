CREATE TABLE IF NOT EXISTS `pomodoro_sessions` (`id` integer PRIMARY KEY NOT NULL, `owner_id` integer NOT NULL, `started_at` integer NOT NULL, `ended_at` integer NOT NULL, `focus_minutes` integer NOT NULL, `break_minutes` integer DEFAULT 5 NOT NULL, `round_index` integer DEFAULT 1 NOT NULL, `completed` integer DEFAULT 1 NOT NULL, `created_at` integer DEFAULT (unixepoch()) NOT NULL, `updated_at` integer DEFAULT (unixepoch()) NOT NULL, FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE cascade);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pomodoro_owner_started` ON `pomodoro_sessions` (`owner_id`, `started_at` DESC);
--> statement-breakpoint
INSERT INTO `info` (`key`, `value`) VALUES ('migration_version', '7') ON CONFLICT(`key`) DO UPDATE SET `value` = '7';
