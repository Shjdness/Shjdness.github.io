CREATE TABLE IF NOT EXISTS `appearance_preferences` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL UNIQUE,
	`settings` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `info` (`key`, `value`) VALUES ('migration_version', '3')
ON CONFLICT(`key`) DO UPDATE SET `value` = '3';
