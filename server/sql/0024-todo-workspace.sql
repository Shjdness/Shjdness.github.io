ALTER TABLE `life_todos` ADD `deadline_at` integer;
ALTER TABLE `life_todos` ADD `completed_at` integer;
ALTER TABLE `life_todos` ADD `sort_order` integer NOT NULL DEFAULT 0;

-- Existing unfinished tasks receive a fresh window at upgrade time.
UPDATE `life_todos` SET `deadline_at` = unixepoch() + 259200
WHERE `type` = 'task' AND `completed` = 0;
UPDATE `life_todos` SET `completed_at` = `updated_at` WHERE `completed` = 1;

INSERT INTO `info` (`key`, `value`) VALUES ('migration_version', '24')
ON CONFLICT(`key`) DO UPDATE SET `value` = '24';
