ALTER TABLE `pomodoro_sessions` ADD `task_name` text DEFAULT '' NOT NULL;
ALTER TABLE `pomodoro_sessions` ADD `completed_early` integer DEFAULT 0 NOT NULL;
