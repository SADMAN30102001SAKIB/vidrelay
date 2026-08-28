ALTER TABLE `posts` ADD `idempotency_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `posts` SET `idempotency_key` = 'legacy:' || `id` WHERE `idempotency_key` = '';--> statement-breakpoint
CREATE UNIQUE INDEX `posts_workspace_idempotency_unique` ON `posts` (`workspace_id`,`idempotency_key`);
