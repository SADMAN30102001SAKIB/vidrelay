ALTER TABLE `posts` ADD `idempotency_key` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `posts_workspace_idempotency_unique` ON `posts` (`workspace_id`,`idempotency_key`);