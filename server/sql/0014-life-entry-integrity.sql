DELETE FROM `daily_basics`
WHERE `id` NOT IN (
  SELECT MIN(`id`)
  FROM `daily_basics`
  GROUP BY `owner_id`, `date`, `content`
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `daily_basics_owner_date_content`
ON `daily_basics` (`owner_id`, `date`, `content`);
--> statement-breakpoint
INSERT INTO `info` (`key`, `value`) VALUES ('migration_version', '14')
ON CONFLICT(`key`) DO UPDATE SET `value` = '14';
