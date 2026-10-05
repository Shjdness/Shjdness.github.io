CREATE TABLE IF NOT EXISTS `life_todos` (
  `id` integer PRIMARY KEY NOT NULL,
  `owner_id` integer NOT NULL,
  `content` text NOT NULL,
  `type` text DEFAULT 'task' NOT NULL,
  `completed` integer DEFAULT 0 NOT NULL,
  `client_key` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS `life_todos_owner_client_key`
ON `life_todos` (`owner_id`, `client_key`);

CREATE INDEX IF NOT EXISTS `life_todos_owner_completed_updated`
ON `life_todos` (`owner_id`, `completed`, `updated_at` DESC);
