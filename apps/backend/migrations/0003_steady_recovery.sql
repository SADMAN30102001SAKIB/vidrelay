ALTER TABLE `deletion_requests` ADD `attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `deletion_requests` ADD `next_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `deletion_requests` ADD `phase` text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE `deletion_requests` ADD `failure_code` text;--> statement-breakpoint
UPDATE `deletion_requests`
SET `attempt_count` = 1
WHERE `status` IN ('processing', 'failed', 'complete');--> statement-breakpoint
UPDATE `deletion_requests`
SET `status` = 'retry_scheduled',
	`next_attempt_at` = `updated_at`,
	`phase` = 'provider_cleanup',
	`failure_code` = 'deletion_processing_failed'
WHERE `status` = 'failed';--> statement-breakpoint
UPDATE `deletion_requests`
SET `phase` = 'provider_cleanup'
WHERE `status` = 'processing';--> statement-breakpoint
UPDATE `deletion_requests`
SET `phase` = 'complete'
WHERE `status` = 'complete';--> statement-breakpoint
CREATE INDEX `deletion_retry_idx` ON `deletion_requests` (`status`,`next_attempt_at`,`requested_at`);
