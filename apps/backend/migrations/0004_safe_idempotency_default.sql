-- Rebuilding posts triggers its cascade chain, so preserve every dependent row explicitly.
CREATE TABLE `__posts_destinations_backup` AS
SELECT * FROM `publish_destinations`;--> statement-breakpoint
CREATE TABLE `__posts_attempts_backup` AS
SELECT * FROM `publish_attempts`;--> statement-breakpoint
CREATE TABLE `__posts_media_leases_backup` AS
SELECT * FROM `media_leases`;--> statement-breakpoint
CREATE TABLE `__new_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`upload_id` text NOT NULL,
	`idempotency_key` text DEFAULT '' NOT NULL,
	`shared_caption` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`rights_confirmed_at` integer,
	`submitted_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
INSERT INTO `__new_posts` (
	`id`,
	`workspace_id`,
	`created_by_user_id`,
	`upload_id`,
	`idempotency_key`,
	`shared_caption`,
	`status`,
	`rights_confirmed_at`,
	`submitted_at`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`workspace_id`,
	`created_by_user_id`,
	`upload_id`,
	`idempotency_key`,
	`shared_caption`,
	`status`,
	`rights_confirmed_at`,
	`submitted_at`,
	`created_at`,
	`updated_at`
FROM `posts`;--> statement-breakpoint
DELETE FROM `media_leases`;--> statement-breakpoint
DELETE FROM `publish_attempts`;--> statement-breakpoint
DELETE FROM `publish_destinations`;--> statement-breakpoint
DROP TABLE `posts`;--> statement-breakpoint
ALTER TABLE `__new_posts` RENAME TO `posts`;--> statement-breakpoint
CREATE UNIQUE INDEX `posts_workspace_idempotency_unique` ON `posts` (`workspace_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `posts_workspace_created_idx` ON `posts` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `posts_workspace_status_idx` ON `posts` (`workspace_id`,`status`);--> statement-breakpoint
INSERT INTO `publish_destinations` (
	`id`,
	`post_id`,
	`connection_id`,
	`platform`,
	`settings_json`,
	`status`,
	`stage`,
	`attempt_number`,
	`workflow_instance_id`,
	`remote_session_id`,
	`remote_upload_url_encrypted`,
	`remote_post_id`,
	`remote_url`,
	`upload_offset`,
	`next_poll_at`,
	`last_error_code`,
	`last_error_message`,
	`outcome_unknown`,
	`published_at`,
	`transition_token`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`post_id`,
	`connection_id`,
	`platform`,
	`settings_json`,
	`status`,
	`stage`,
	`attempt_number`,
	`workflow_instance_id`,
	`remote_session_id`,
	`remote_upload_url_encrypted`,
	`remote_post_id`,
	`remote_url`,
	`upload_offset`,
	`next_poll_at`,
	`last_error_code`,
	`last_error_message`,
	`outcome_unknown`,
	`published_at`,
	`transition_token`,
	`created_at`,
	`updated_at`
FROM `__posts_destinations_backup`;--> statement-breakpoint
INSERT INTO `publish_attempts` (
	`id`,
	`destination_id`,
	`attempt_number`,
	`workflow_instance_id`,
	`status`,
	`stage`,
	`remote_session_id`,
	`remote_post_id`,
	`error_code`,
	`error_message`,
	`started_at`,
	`finished_at`,
	`updated_at`
)
SELECT
	`id`,
	`destination_id`,
	`attempt_number`,
	`workflow_instance_id`,
	`status`,
	`stage`,
	`remote_session_id`,
	`remote_post_id`,
	`error_code`,
	`error_message`,
	`started_at`,
	`finished_at`,
	`updated_at`
FROM `__posts_attempts_backup`;--> statement-breakpoint
INSERT INTO `media_leases` (
	`id`,
	`upload_id`,
	`destination_id`,
	`purpose`,
	`expires_at`,
	`revoked_at`,
	`created_at`
)
SELECT
	`id`,
	`upload_id`,
	`destination_id`,
	`purpose`,
	`expires_at`,
	`revoked_at`,
	`created_at`
FROM `__posts_media_leases_backup`;--> statement-breakpoint
DROP TABLE `__posts_destinations_backup`;--> statement-breakpoint
DROP TABLE `__posts_attempts_backup`;--> statement-breakpoint
DROP TABLE `__posts_media_leases_backup`;
