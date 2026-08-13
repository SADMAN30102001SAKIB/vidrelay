import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer("created_at")
    .notNull()
    .default(sql.raw("(unixepoch() * 1000)")),
  updatedAt: integer("updated_at")
    .notNull()
    .default(sql.raw("(unixepoch() * 1000)"))
};

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["customer", "operator"] })
      .notNull()
      .default("customer"),
    status: text("status", {
      enum: ["active", "suspended", "deletion_pending", "deleted"]
    })
      .notNull()
      .default("active"),
    emailVerifiedAt: integer("email_verified_at"),
    lastLoginAt: integer("last_login_at"),
    ...timestamps
  },
  table => [
    uniqueIndex("users_email_unique").on(table.email),
    index("users_status_idx").on(table.status)
  ]
);

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    status: text("status", { enum: ["active", "deletion_pending", "deleted"] })
      .notNull()
      .default("active"),
    ...timestamps
  },
  table => [uniqueIndex("workspaces_slug_unique").on(table.slug)]
);

export const memberships = sqliteTable(
  "memberships",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "member"] })
      .notNull()
      .default("owner"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql.raw("(unixepoch() * 1000)"))
  },
  table => [
    primaryKey({ columns: [table.userId, table.workspaceId] }),
    index("memberships_workspace_idx").on(table.workspaceId)
  ]
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    userAgent: text("user_agent"),
    ipHash: text("ip_hash"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql.raw("(unixepoch() * 1000)"))
  },
  table => [
    index("sessions_user_idx").on(table.userId),
    index("sessions_expiry_idx").on(table.expiresAt)
  ]
);

export const authAttempts = sqliteTable(
  "auth_attempts",
  {
    key: text("key").primaryKey(),
    attempts: integer("attempts").notNull().default(0),
    windowStartedAt: integer("window_started_at").notNull(),
    blockedUntil: integer("blocked_until"),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql.raw("(unixepoch() * 1000)"))
  },
  table => [index("auth_attempts_updated_idx").on(table.updatedAt)]
);

export const oauthStates = sqliteTable(
  "oauth_states",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider", {
      enum: ["facebook", "instagram", "youtube", "tiktok"]
    }).notNull(),
    returnTo: text("return_to").notNull(),
    codeVerifierEncrypted: text("code_verifier_encrypted"),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql.raw("(unixepoch() * 1000)"))
  },
  table => [
    index("oauth_states_session_idx").on(table.sessionId),
    index("oauth_states_user_idx").on(table.userId),
    index("oauth_states_expiry_idx").on(table.expiresAt)
  ]
);

export const socialConnections = sqliteTable(
  "social_connections",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectedByUserId: text("connected_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    provider: text("provider", {
      enum: ["facebook", "instagram", "youtube", "tiktok"]
    }).notNull(),
    remoteAccountId: text("remote_account_id").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    scopesJson: text("scopes_json").notNull().default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    status: text("status", {
      enum: ["connected", "reauth_required", "limited", "disconnected"]
    })
      .notNull()
      .default("connected"),
    expiresAt: integer("expires_at"),
    lastCheckedAt: integer("last_checked_at"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    disconnectedAt: integer("disconnected_at"),
    refreshLeaseId: text("refresh_lease_id"),
    refreshLeaseExpiresAt: integer("refresh_lease_expires_at"),
    ...timestamps
  },
  table => [
    uniqueIndex("connections_workspace_provider_remote_unique").on(
      table.workspaceId,
      table.provider,
      table.remoteAccountId
    ),
    index("connections_workspace_idx").on(table.workspaceId),
    index("connections_status_idx").on(table.status)
  ]
);

export const uploads = sqliteTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    r2Key: text("r2_key").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    expectedSize: integer("expected_size").notNull(),
    actualSize: integer("actual_size"),
    uploadMode: text("upload_mode", {
      enum: ["direct", "worker_proxy"]
    }).notNull(),
    multipartUploadId: text("multipart_upload_id"),
    partSize: integer("part_size").notNull(),
    status: text("status", {
      enum: [
        "created",
        "uploading",
        "verifying",
        "ready",
        "rejected",
        "aborted"
      ]
    })
      .notNull()
      .default("created"),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    fpsMilli: integer("fps_milli"),
    videoCodec: text("video_codec"),
    audioCodec: text("audio_codec"),
    validationJson: text("validation_json")
      .notNull()
      .default('{"errors":[],"warnings":[]}'),
    completedAt: integer("completed_at"),
    storageDeletedAt: integer("storage_deleted_at"),
    ...timestamps
  },
  table => [
    uniqueIndex("uploads_r2_key_unique").on(table.r2Key),
    index("uploads_workspace_status_idx").on(table.workspaceId, table.status),
    index("uploads_created_idx").on(table.createdAt)
  ]
);

export const posts = sqliteTable(
  "posts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    uploadId: text("upload_id")
      .notNull()
      .references(() => uploads.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull().default(""),
    sharedCaption: text("shared_caption").notNull().default(""),
    status: text("status", {
      enum: [
        "draft",
        "ready",
        "queued",
        "publishing",
        "partial_success",
        "published",
        "failed",
        "cancelled"
      ]
    })
      .notNull()
      .default("draft"),
    rightsConfirmedAt: integer("rights_confirmed_at"),
    submittedAt: integer("submitted_at"),
    ...timestamps
  },
  table => [
    uniqueIndex("posts_workspace_idempotency_unique").on(
      table.workspaceId,
      table.idempotencyKey
    ),
    index("posts_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("posts_workspace_status_idx").on(table.workspaceId, table.status)
  ]
);

export const publishDestinations = sqliteTable(
  "publish_destinations",
  {
    id: text("id").primaryKey(),
    postId: text("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => socialConnections.id, { onDelete: "restrict" }),
    platform: text("platform", {
      enum: ["facebook", "instagram", "youtube", "tiktok"]
    }).notNull(),
    settingsJson: text("settings_json").notNull(),
    status: text("status", {
      enum: [
        "blocked",
        "queued",
        "starting",
        "transferring",
        "processing",
        "publishing",
        "retry_scheduled",
        "published",
        "awaiting_user_action",
        "reauth_required",
        "failed_permanent",
        "reconciliation_required",
        "cancelled",
        "unavailable"
      ]
    })
      .notNull()
      .default("queued"),
    stage: text("stage").notNull().default("queued"),
    attemptNumber: integer("attempt_number").notNull().default(1),
    workflowInstanceId: text("workflow_instance_id"),
    remoteSessionId: text("remote_session_id"),
    remoteUploadUrlEncrypted: text("remote_upload_url_encrypted"),
    remotePostId: text("remote_post_id"),
    remoteUrl: text("remote_url"),
    uploadOffset: integer("upload_offset").notNull().default(0),
    nextPollAt: integer("next_poll_at"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    outcomeUnknown: integer("outcome_unknown", { mode: "boolean" })
      .notNull()
      .default(false),
    publishedAt: integer("published_at"),
    transitionToken: text("transition_token"),
    ...timestamps
  },
  table => [
    uniqueIndex("destinations_post_connection_unique").on(
      table.postId,
      table.connectionId
    ),
    index("destinations_post_idx").on(table.postId),
    index("destinations_status_poll_idx").on(table.status, table.nextPollAt)
  ]
);

export const publishAttempts = sqliteTable(
  "publish_attempts",
  {
    id: text("id").primaryKey(),
    destinationId: text("destination_id")
      .notNull()
      .references(() => publishDestinations.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    workflowInstanceId: text("workflow_instance_id").notNull(),
    status: text("status").notNull(),
    stage: text("stage").notNull(),
    remoteSessionId: text("remote_session_id"),
    remotePostId: text("remote_post_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql.raw("(unixepoch() * 1000)"))
  },
  table => [
    uniqueIndex("attempts_destination_number_unique").on(
      table.destinationId,
      table.attemptNumber
    ),
    uniqueIndex("attempts_workflow_unique").on(table.workflowInstanceId)
  ]
);

export const outboxEvents = sqliteTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type", {
      enum: ["publish_destination", "delete_workspace"]
    }).notNull(),
    aggregateId: text("aggregate_id").notNull(),
    attemptNumber: integer("attempt_number").notNull().default(1),
    dispatchedAt: integer("dispatched_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql.raw("(unixepoch() * 1000)"))
  },
  table => [
    uniqueIndex("outbox_aggregate_attempt_unique").on(
      table.eventType,
      table.aggregateId,
      table.attemptNumber
    ),
    index("outbox_pending_idx").on(table.dispatchedAt, table.createdAt)
  ]
);

export const mediaLeases = sqliteTable(
  "media_leases",
  {
    id: text("id").primaryKey(),
    uploadId: text("upload_id")
      .notNull()
      .references(() => uploads.id, { onDelete: "cascade" }),
    destinationId: text("destination_id").references(
      () => publishDestinations.id,
      {
        onDelete: "cascade"
      }
    ),
    purpose: text("purpose", {
      enum: ["facebook", "instagram", "tiktok", "preview"]
    }).notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql.raw("(unixepoch() * 1000)"))
  },
  table => [
    index("media_leases_upload_idx").on(table.uploadId),
    index("media_leases_expiry_idx").on(table.expiresAt)
  ]
);

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider", {
      enum: ["facebook", "instagram", "tiktok"]
    }).notNull(),
    providerEventId: text("provider_event_id"),
    payloadHash: text("payload_hash").notNull(),
    status: text("status", {
      enum: ["received", "processed", "ignored", "failed"]
    })
      .notNull()
      .default("received"),
    processedAt: integer("processed_at"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql.raw("(unixepoch() * 1000)"))
  },
  table => [
    uniqueIndex("webhook_provider_payload_unique").on(
      table.provider,
      table.payloadHash
    ),
    index("webhook_status_idx").on(table.status, table.createdAt)
  ]
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "set null"
    }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql.raw("(unixepoch() * 1000)"))
  },
  table => [
    index("audit_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("audit_actor_created_idx").on(table.actorUserId, table.createdAt)
  ]
);

export const deletionRequests = sqliteTable(
  "deletion_requests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "set null"
    }),
    status: text("status", {
      enum: [
        "requested",
        "processing",
        "retry_scheduled",
        "manual_review",
        "complete"
      ]
    })
      .notNull()
      .default("requested"),
    confirmationReferenceHash: text("confirmation_reference_hash").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    phase: text("phase", {
      enum: [
        "queued",
        "provider_cleanup",
        "media_cleanup",
        "account_cleanup",
        "complete"
      ]
    })
      .notNull()
      .default("queued"),
    failureCode: text("failure_code", {
      enum: [
        "deletion_interrupted",
        "provider_cleanup_failed",
        "media_cleanup_failed",
        "account_cleanup_failed",
        "deletion_processing_failed",
        "deletion_subject_missing"
      ]
    }),
    lastError: text("last_error"),
    requestedAt: integer("requested_at").notNull(),
    completedAt: integer("completed_at"),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql.raw("(unixepoch() * 1000)"))
  },
  table => [
    index("deletion_status_idx").on(table.status, table.requestedAt),
    index("deletion_retry_idx").on(
      table.status,
      table.nextAttemptAt,
      table.requestedAt
    ),
    uniqueIndex("deletion_workspace_active_unique").on(
      table.workspaceId,
      table.status
    )
  ]
);
