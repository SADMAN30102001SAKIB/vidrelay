-- An OAuth handshake that predates session binding cannot be associated safely,
-- so replace this short-lived table instead of fabricating session ownership.
CREATE TABLE `__new_oauth_states` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`return_to` text NOT NULL,
	`code_verifier_encrypted` text,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
DROP TABLE `oauth_states`;--> statement-breakpoint
ALTER TABLE `__new_oauth_states` RENAME TO `oauth_states`;--> statement-breakpoint
CREATE INDEX `oauth_states_session_idx` ON `oauth_states` (`session_id`);--> statement-breakpoint
CREATE INDEX `oauth_states_user_idx` ON `oauth_states` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauth_states_expiry_idx` ON `oauth_states` (`expires_at`);--> statement-breakpoint
ALTER TABLE `publish_destinations` ADD `transition_token` text;--> statement-breakpoint
ALTER TABLE `social_connections` ADD `refresh_lease_id` text;--> statement-breakpoint
ALTER TABLE `social_connections` ADD `refresh_lease_expires_at` integer;--> statement-breakpoint
ALTER TABLE `uploads` ADD `storage_deleted_at` integer;
