CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`workspace_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_workspace_created_idx` ON `audit_events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_actor_created_idx` ON `audit_events` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `auth_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`window_started_at` integer NOT NULL,
	`blocked_until` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_attempts_updated_idx` ON `auth_attempts` (`updated_at`);--> statement-breakpoint
CREATE TABLE `deletion_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`workspace_id` text,
	`status` text DEFAULT 'requested' NOT NULL,
	`confirmation_reference_hash` text NOT NULL,
	`last_error` text,
	`requested_at` integer NOT NULL,
	`completed_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `deletion_status_idx` ON `deletion_requests` (`status`,`requested_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `deletion_workspace_active_unique` ON `deletion_requests` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `media_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`upload_id` text NOT NULL,
	`destination_id` text,
	`purpose` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `publish_destinations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `media_leases_upload_idx` ON `media_leases` (`upload_id`);--> statement-breakpoint
CREATE INDEX `media_leases_expiry_idx` ON `media_leases` (`expires_at`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `workspace_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memberships_workspace_idx` ON `memberships` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`return_to` text NOT NULL,
	`code_verifier_encrypted` text,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_states_user_idx` ON `oauth_states` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauth_states_expiry_idx` ON `oauth_states` (`expires_at`);--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`attempt_number` integer DEFAULT 1 NOT NULL,
	`dispatched_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_aggregate_attempt_unique` ON `outbox_events` (`event_type`,`aggregate_id`,`attempt_number`);--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox_events` (`dispatched_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`upload_id` text NOT NULL,
	`shared_caption` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`rights_confirmed_at` integer,
	`submitted_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `posts_workspace_created_idx` ON `posts` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `posts_workspace_status_idx` ON `posts` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `publish_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`destination_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`workflow_instance_id` text NOT NULL,
	`status` text NOT NULL,
	`stage` text NOT NULL,
	`remote_session_id` text,
	`remote_post_id` text,
	`error_code` text,
	`error_message` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`destination_id`) REFERENCES `publish_destinations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_destination_number_unique` ON `publish_attempts` (`destination_id`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_workflow_unique` ON `publish_attempts` (`workflow_instance_id`);--> statement-breakpoint
CREATE TABLE `publish_destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`platform` text NOT NULL,
	`settings_json` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text DEFAULT 'queued' NOT NULL,
	`attempt_number` integer DEFAULT 1 NOT NULL,
	`workflow_instance_id` text,
	`remote_session_id` text,
	`remote_upload_url_encrypted` text,
	`remote_post_id` text,
	`remote_url` text,
	`upload_offset` integer DEFAULT 0 NOT NULL,
	`next_poll_at` integer,
	`last_error_code` text,
	`last_error_message` text,
	`outcome_unknown` integer DEFAULT false NOT NULL,
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `social_connections`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `destinations_post_connection_unique` ON `publish_destinations` (`post_id`,`connection_id`);--> statement-breakpoint
CREATE INDEX `destinations_post_idx` ON `publish_destinations` (`post_id`);--> statement-breakpoint
CREATE INDEX `destinations_status_poll_idx` ON `publish_destinations` (`status`,`next_poll_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`user_agent` text,
	`ip_hash` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `social_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`connected_by_user_id` text NOT NULL,
	`provider` text NOT NULL,
	`remote_account_id` text NOT NULL,
	`display_name` text NOT NULL,
	`avatar_url` text,
	`credentials_encrypted` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`scopes_json` text DEFAULT '[]' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'connected' NOT NULL,
	`expires_at` integer,
	`last_checked_at` integer,
	`last_error_code` text,
	`last_error_message` text,
	`disconnected_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connected_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_workspace_provider_remote_unique` ON `social_connections` (`workspace_id`,`provider`,`remote_account_id`);--> statement-breakpoint
CREATE INDEX `connections_workspace_idx` ON `social_connections` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `connections_status_idx` ON `social_connections` (`status`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`expected_size` integer NOT NULL,
	`actual_size` integer,
	`upload_mode` text NOT NULL,
	`multipart_upload_id` text,
	`part_size` integer NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`fps_milli` integer,
	`video_codec` text,
	`audio_codec` text,
	`validation_json` text DEFAULT '{"errors":[],"warnings":[]}' NOT NULL,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uploads_r2_key_unique` ON `uploads` (`r2_key`);--> statement-breakpoint
CREATE INDEX `uploads_workspace_status_idx` ON `uploads` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `uploads_created_idx` ON `uploads` (`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'customer' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`email_verified_at` integer,
	`last_login_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_event_id` text,
	`payload_hash` text NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`processed_at` integer,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_provider_payload_unique` ON `webhook_events` (`provider`,`payload_hash`);--> statement-breakpoint
CREATE INDEX `webhook_status_idx` ON `webhook_events` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);