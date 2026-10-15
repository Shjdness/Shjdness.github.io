ALTER TABLE `pomodoro_sessions` ADD `todo_id` integer REFERENCES `life_todos`(`id`) ON DELETE SET NULL;
ALTER TABLE `pomodoro_sessions` ADD `client_key` text;

CREATE INDEX IF NOT EXISTS `pomodoro_sessions_owner_todo_started`
ON `pomodoro_sessions` (`owner_id`, `todo_id`, `started_at` DESC);

CREATE UNIQUE INDEX IF NOT EXISTS `pomodoro_sessions_owner_client_key`
ON `pomodoro_sessions` (`owner_id`, `client_key`);

INSERT INTO `info` (`key`, `value`) VALUES ('migration_version', '22')
ON CONFLICT(`key`) DO UPDATE SET `value` = '22';
