ALTER TABLE `users` ADD COLUMN `access_expires_at` integer;
--> statement-breakpoint
INSERT INTO `info` (`key`, `value`) VALUES ('migration_version', '4')
ON CONFLICT(`key`) DO UPDATE SET `value` = '4';
