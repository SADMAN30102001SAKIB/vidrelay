import {
  createPostSchema,
  reconcileDestinationSchema,
  retryDestinationSchema,
  type Post
} from "@vidrelay/shared";
import {
  and,
  desc,
  eq,
  inArray,
  lt,
  or
} from "drizzle-orm";
import { Hono } from "hono";

import type { AppEnv } from "../env";
import { createDb, type Database } from "../db/client";
import {
  posts,
  publishAttempts,
  publishDestinations,
  socialConnections,
  uploads
} from "../db/schema";
import { writeAuditEvent } from "../lib/audit";
import { getCapability } from "../lib/capabilities";
import { AppError } from "../lib/errors";
import { parseJson } from "../lib/json";
import { toDestination, toUpload } from "../lib/mappers";
import { requireAuth } from "../middleware/auth";
import { dispatchOutbox, workflowInstanceId } from "../publishing/outbox";
import { recomputePostStatus } from "../publishing/repository";

const buildPost = async (
  db: Database,
  postId: string,
  workspaceId: string
): Promise<Post> => {
  const [row] = await db
    .select({ post: posts, upload: uploads })
    .from(posts)
    .innerJoin(uploads, eq(uploads.id, posts.uploadId))
    .where(and(eq(posts.id, postId), eq(posts.workspaceId, workspaceId)))
    .limit(1);
  if (row === undefined) {
    throw new AppError(404, "post_not_found", "The post was not found.");
  }
  const destinations = await db
    .select({
      connectionDisplayName: socialConnections.displayName,
      destination: publishDestinations
    })
    .from(publishDestinations)
    .innerJoin(
      socialConnections,
      eq(socialConnections.id, publishDestinations.connectionId)
    )
    .where(eq(publishDestinations.postId, postId));

  return {
    createdAt: row.post.createdAt,
    destinations: destinations.map(item =>
      toDestination(item.destination, item.connectionDisplayName)
    ),
    id: row.post.id,
    sharedCaption: row.post.sharedCaption,
    status: row.post.status,
    submittedAt: row.post.submittedAt,
    updatedAt: row.post.updatedAt,
    upload: toUpload(row.upload)
  };
};

const encodeCursor = (createdAt: number, id: string): string =>
  btoa(String(createdAt) + ":" + id)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const decodeCursor = (value: string): { createdAt: number; id: string } => {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
    const separator = decoded.indexOf(":");
    const createdAt = Number(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (
      separator < 1 ||
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0 ||
      id.length === 0
    ) {
      throw new Error("invalid");
    }
    return { createdAt, id };
  } catch {
    throw new AppError(400, "invalid_cursor", "The pagination cursor is invalid.");
  }
};

const enforceCapability = (
  context: {
    env: AppEnv["Bindings"];
  },
  platform: "facebook" | "instagram" | "youtube" | "tiktok",
  settings: Record<string, unknown>
): void => {
  const capability = getCapability(context.env, platform);
  if (
    !capability.configured ||
    capability.mode === "disabled" ||
    capability.mode === "review_pending" ||
    (capability.mode === "development_only" && context.env.APP_ENV === "production")
  ) {
    throw new AppError(
      409,
      "capability_unavailable",
      capability.message,
      { platform }
    );
  }
  if (
    platform === "youtube" &&
    capability.mode === "private_only" &&
    settings.privacyStatus !== "private"
  ) {
    throw new AppError(
      409,
      "private_only",
      "YouTube publishing is restricted to private visibility until audit approval."
    );
  }
  if (
    platform === "tiktok" &&
    capability.mode === "private_only" &&
    settings.privacyLevel !== "SELF_ONLY"
  ) {
    throw new AppError(
      409,
      "private_only",
      "TikTok publishing is restricted to private visibility until audit approval."
    );
  }
  if (platform === "tiktok" && capability.mode === "inbox_only") {
    throw new AppError(
      409,
      "inbox_mode_not_selected",
      "This connection is configured for TikTok inbox delivery, not Direct Post."
    );
  }
};

export const postRoutes = new Hono<AppEnv>();
postRoutes.use("*", requireAuth);

postRoutes.get("/", async context => {
  const auth = context.get("auth");
  const cursorValue = context.req.query("cursor");
  const cursor = cursorValue === undefined ? null : decodeCursor(cursorValue);
  const db = createDb(context.env.DB);
  const condition =
    cursor === null
      ? eq(posts.workspaceId, auth.workspaceId)
      : and(
          eq(posts.workspaceId, auth.workspaceId),
          or(
            lt(posts.createdAt, cursor.createdAt),
            and(eq(posts.createdAt, cursor.createdAt), lt(posts.id, cursor.id))
          )
        );
  const rows = await db
    .select({ createdAt: posts.createdAt, id: posts.id })
    .from(posts)
    .where(condition)
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(21);
  const pageRows = rows.slice(0, 20);
  const items = await Promise.all(
    pageRows.map(row => buildPost(db, row.id, auth.workspaceId))
  );
  const last = rows.length > 20 ? pageRows[pageRows.length - 1] : undefined;
  return context.json({
    items,
    nextCursor: last === undefined ? null : encodeCursor(last.createdAt, last.id)
  });
});

postRoutes.get("/:id", async context => {
  const auth = context.get("auth");
  const db = createDb(context.env.DB);
  const post = await buildPost(db, context.req.param("id"), auth.workspaceId);
  const attempts = await db
    .select({
      attemptNumber: publishAttempts.attemptNumber,
      destinationId: publishAttempts.destinationId,
      errorCode: publishAttempts.errorCode,
      errorMessage: publishAttempts.errorMessage,
      finishedAt: publishAttempts.finishedAt,
      stage: publishAttempts.stage,
      startedAt: publishAttempts.startedAt,
      status: publishAttempts.status,
      updatedAt: publishAttempts.updatedAt
    })
    .from(publishAttempts)
    .innerJoin(
      publishDestinations,
      eq(publishDestinations.id, publishAttempts.destinationId)
    )
    .where(eq(publishDestinations.postId, post.id))
    .orderBy(desc(publishAttempts.startedAt));
  return context.json({ attempts, post });
});

postRoutes.post("/", async context => {
  const auth = context.get("auth");
  const input = await parseJson(context, createPostSchema);
  const db = createDb(context.env.DB);
  const [existing] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        eq(posts.workspaceId, auth.workspaceId),
        eq(posts.idempotencyKey, input.idempotencyKey)
      )
    )
    .limit(1);
  if (existing !== undefined) {
    return context.json({
      idempotentReplay: true,
      post: await buildPost(db, existing.id, auth.workspaceId)
    });
  }

  const [upload] = await db
    .select()
    .from(uploads)
    .where(
      and(
        eq(uploads.id, input.uploadId),
        eq(uploads.workspaceId, auth.workspaceId),
        eq(uploads.status, "ready")
      )
    )
    .limit(1);
  if (upload === undefined) {
    throw new AppError(409, "upload_not_ready", "Choose a verified, ready video.");
  }

  const connectionIds = input.destinations.map(destination => destination.connectionId);
  const connections = await db
    .select()
    .from(socialConnections)
    .where(
      and(
        eq(socialConnections.workspaceId, auth.workspaceId),
        inArray(socialConnections.id, connectionIds)
      )
    );
  if (connections.length !== connectionIds.length) {
    throw new AppError(422, "invalid_connection", "A selected connection was not found.");
  }
  const connectionById = new Map(connections.map(connection => [connection.id, connection]));
  for (const destination of input.destinations) {
    const connection = connectionById.get(destination.connectionId);
    if (
      connection?.provider !== destination.platform ||
      connection.status !== "connected"
    ) {
      throw new AppError(
        409,
        "connection_unavailable",
        "Reconnect or replace an unavailable destination.",
        { platform: destination.platform }
      );
    }
    enforceCapability(context, destination.platform, destination.settings);
  }

  const now = Date.now();
  const postId = crypto.randomUUID();
  const records = input.destinations.map(destination => {
    const destinationId = crypto.randomUUID();
    const attemptNumber = 1;
    return {
      attemptId: crypto.randomUUID(),
      attemptNumber,
      destination,
      destinationId,
      workflowId: workflowInstanceId(destinationId, attemptNumber)
    };
  });
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(
      "INSERT INTO posts (id, workspace_id, created_by_user_id, upload_id, idempotency_key, shared_caption, status, rights_confirmed_at, submitted_at, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ? FROM workspaces INNER JOIN memberships ON memberships.workspace_id = workspaces.id INNER JOIN users ON users.id = memberships.user_id INNER JOIN uploads ON uploads.id = ? AND uploads.workspace_id = workspaces.id WHERE workspaces.id = ? AND workspaces.status = 'active' AND users.id = ? AND users.status = 'active' AND uploads.status = 'ready'"
    ).bind(
      postId,
      auth.workspaceId,
      auth.userId,
      upload.id,
      input.idempotencyKey,
      input.sharedCaption,
      now,
      now,
      now,
      now,
      upload.id,
      auth.workspaceId,
      auth.userId
    )
  ];
  for (const record of records) {
    statements.push(
      context.env.DB.prepare(
        "INSERT INTO publish_destinations (id, post_id, connection_id, platform, settings_json, status, stage, attempt_number, upload_offset, outcome_unknown, created_at, updated_at) SELECT ?, ?, ?, ?, ?, 'queued', 'queued', ?, 0, 0, ?, ? FROM social_connections INNER JOIN posts ON posts.id = ? WHERE social_connections.id = ? AND social_connections.workspace_id = ? AND social_connections.provider = ? AND social_connections.status = 'connected' AND posts.workspace_id = ?"
      ).bind(
        record.destinationId,
        postId,
        record.destination.connectionId,
        record.destination.platform,
        JSON.stringify(record.destination.settings),
        record.attemptNumber,
        now,
        now,
        postId,
        record.destination.connectionId,
        auth.workspaceId,
        record.destination.platform,
        auth.workspaceId
      ),
      context.env.DB.prepare(
        "INSERT INTO publish_attempts (id, destination_id, attempt_number, workflow_instance_id, status, stage, started_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 'queued', ?, ?)"
      ).bind(
        record.attemptId,
        record.destinationId,
        record.attemptNumber,
        record.workflowId,
        now,
        now
      ),
      context.env.DB.prepare(
        "INSERT INTO outbox_events (id, event_type, aggregate_id, attempt_number, created_at) VALUES (?, 'publish_destination', ?, ?, ?)"
      ).bind(
        record.workflowId,
        record.destinationId,
        record.attemptNumber,
        now
      )
    );
  }

  try {
    await context.env.DB.batch(statements);
  } catch (error) {
    const [replayed] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(
        and(
          eq(posts.workspaceId, auth.workspaceId),
          eq(posts.idempotencyKey, input.idempotencyKey)
        )
      )
      .limit(1);
    if (replayed !== undefined) {
      return context.json({
        idempotentReplay: true,
        post: await buildPost(db, replayed.id, auth.workspaceId)
      });
    }
    const active = await context.env.DB.prepare(
      "SELECT 1 AS active FROM users INNER JOIN memberships ON memberships.user_id = users.id INNER JOIN workspaces ON workspaces.id = memberships.workspace_id WHERE users.id = ? AND users.status = 'active' AND workspaces.id = ? AND workspaces.status = 'active'"
    )
      .bind(auth.userId, auth.workspaceId)
      .first();
    if (active === null) {
      throw new AppError(
        409,
        "account_not_active",
        "The account changed while the post was being submitted."
      );
    }
    throw error;
  }

  await writeAuditEvent(db, {
    action: "post.submitted",
    actorUserId: auth.userId,
    entityId: postId,
    entityType: "post",
    metadata: {
      destinations: input.destinations.map(destination => destination.platform)
    },
    workspaceId: auth.workspaceId
  });
  context.executionCtx.waitUntil(dispatchOutbox(context.env));
  return context.json(
    {
      idempotentReplay: false,
      post: await buildPost(db, postId, auth.workspaceId)
    },
    202
  );
});

const retryableStatuses = [
  "failed_permanent",
  "reauth_required",
  "unavailable"
] as const;

postRoutes.post("/:postId/destinations/:destinationId/retry", async context => {
  await parseJson(context, retryDestinationSchema);
  const auth = context.get("auth");
  const db = createDb(context.env.DB);
  const [row] = await db
    .select({
      connectionStatus: socialConnections.status,
      destination: publishDestinations
    })
    .from(publishDestinations)
    .innerJoin(posts, eq(posts.id, publishDestinations.postId))
    .innerJoin(
      socialConnections,
      eq(socialConnections.id, publishDestinations.connectionId)
    )
    .where(
      and(
        eq(publishDestinations.id, context.req.param("destinationId")),
        eq(publishDestinations.postId, context.req.param("postId")),
        eq(posts.workspaceId, auth.workspaceId)
      )
    )
    .limit(1);
  if (row === undefined) {
    throw new AppError(404, "destination_not_found", "The destination was not found.");
  }
  if (
    !retryableStatuses.includes(
      row.destination.status as (typeof retryableStatuses)[number]
    ) ||
    row.connectionStatus !== "connected"
  ) {
    throw new AppError(
      409,
      "destination_not_retryable",
      "This destination cannot be retried in its current state."
    );
  }
  enforceCapability(
    context,
    row.destination.platform,
    JSON.parse(row.destination.settingsJson) as Record<string, unknown>
  );

  const attemptNumber = row.destination.attemptNumber + 1;
  const workflowId = workflowInstanceId(row.destination.id, attemptNumber);
  const now = Date.now();
  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare(
        "UPDATE publish_destinations SET status = 'queued', stage = 'queued', attempt_number = ?, workflow_instance_id = NULL, next_poll_at = NULL, last_error_code = NULL, last_error_message = NULL, outcome_unknown = 0, updated_at = ? WHERE id = ? AND attempt_number = ? AND status = ? AND EXISTS (SELECT 1 FROM social_connections INNER JOIN posts ON posts.id = publish_destinations.post_id INNER JOIN workspaces ON workspaces.id = posts.workspace_id WHERE social_connections.id = publish_destinations.connection_id AND social_connections.status = 'connected' AND workspaces.status = 'active')"
      ).bind(
        attemptNumber,
        now,
        row.destination.id,
        row.destination.attemptNumber,
        row.destination.status
      ),
      context.env.DB.prepare(
        "INSERT INTO publish_attempts (id, destination_id, attempt_number, workflow_instance_id, status, stage, started_at, updated_at) SELECT ?, ?, ?, ?, 'queued', 'queued', ?, ? FROM publish_destinations WHERE id = ? AND attempt_number = ? AND status = 'queued'"
      ).bind(
        crypto.randomUUID(),
        row.destination.id,
        attemptNumber,
        workflowId,
        now,
        now,
        row.destination.id,
        attemptNumber
      ),
      context.env.DB.prepare(
        "INSERT INTO outbox_events (id, event_type, aggregate_id, attempt_number, created_at) SELECT ?, 'publish_destination', ?, ?, ? FROM publish_destinations WHERE id = ? AND attempt_number = ? AND status = 'queued'"
      ).bind(
        workflowId,
        row.destination.id,
        attemptNumber,
        now,
        row.destination.id,
        attemptNumber
      ),
      context.env.DB.prepare(
        "UPDATE posts SET status = 'publishing', updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM publish_destinations WHERE publish_destinations.post_id = posts.id AND publish_destinations.id = ? AND publish_destinations.attempt_number = ? AND publish_destinations.status = 'queued')"
      ).bind(now, row.destination.postId, row.destination.id, attemptNumber)
    ]);
    if (results[0]?.meta.changes !== 1) {
      throw new AppError(
        409,
        "retry_conflict",
        "The destination changed while the retry was being requested."
      );
    }
  } catch {
    throw new AppError(409, "retry_conflict", "A retry has already been requested.");
  }
  await writeAuditEvent(db, {
    action: "destination.retry_requested",
    actorUserId: auth.userId,
    entityId: row.destination.id,
    entityType: "publish_destination",
    metadata: { attemptNumber },
    workspaceId: auth.workspaceId
  });
  context.executionCtx.waitUntil(dispatchOutbox(context.env));
  return context.json(
    { post: await buildPost(db, row.destination.postId, auth.workspaceId) },
    202
  );
});

postRoutes.post("/:postId/destinations/:destinationId/reconcile", async context => {
  await parseJson(context, reconcileDestinationSchema);
  const auth = context.get("auth");
  const db = createDb(context.env.DB);
  const [row] = await db
    .select({ destination: publishDestinations })
    .from(publishDestinations)
    .innerJoin(posts, eq(posts.id, publishDestinations.postId))
    .where(
      and(
        eq(publishDestinations.id, context.req.param("destinationId")),
        eq(publishDestinations.postId, context.req.param("postId")),
        eq(posts.workspaceId, auth.workspaceId)
      )
    )
    .limit(1);
  if (row?.destination.status !== "reconciliation_required") {
    throw new AppError(
      409,
      "reconciliation_unavailable",
      "This destination is not awaiting reconciliation."
    );
  }
  if (
    (row.destination.remoteSessionId === null &&
      row.destination.remotePostId === null) ||
    (row.destination.platform === "instagram" && row.destination.remotePostId === null)
  ) {
    throw new AppError(
      409,
      "manual_provider_check_required",
      "No provider identifier is available for safe automatic reconciliation. Check the provider account before requesting a retry."
    );
  }

  const attemptNumber = row.destination.attemptNumber + 1;
  const workflowId = workflowInstanceId(row.destination.id, attemptNumber);
  const now = Date.now();
  const results = await context.env.DB.batch([
    context.env.DB.prepare(
      "UPDATE publish_destinations SET status = 'queued', stage = 'reconcile_only', attempt_number = ?, workflow_instance_id = NULL, next_poll_at = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE id = ? AND attempt_number = ? AND status = 'reconciliation_required' AND EXISTS (SELECT 1 FROM social_connections INNER JOIN posts ON posts.id = publish_destinations.post_id INNER JOIN workspaces ON workspaces.id = posts.workspace_id WHERE social_connections.id = publish_destinations.connection_id AND social_connections.status = 'connected' AND workspaces.status = 'active')"
    ).bind(attemptNumber, now, row.destination.id, row.destination.attemptNumber),
    context.env.DB.prepare(
      "INSERT INTO publish_attempts (id, destination_id, attempt_number, workflow_instance_id, status, stage, started_at, updated_at) SELECT ?, ?, ?, ?, 'queued', 'reconcile_only', ?, ? FROM publish_destinations WHERE id = ? AND attempt_number = ? AND status = 'queued' AND stage = 'reconcile_only'"
    ).bind(
      crypto.randomUUID(),
      row.destination.id,
      attemptNumber,
      workflowId,
      now,
      now,
      row.destination.id,
      attemptNumber
    ),
    context.env.DB.prepare(
      "INSERT INTO outbox_events (id, event_type, aggregate_id, attempt_number, created_at) SELECT ?, 'publish_destination', ?, ?, ? FROM publish_destinations WHERE id = ? AND attempt_number = ? AND status = 'queued' AND stage = 'reconcile_only'"
    ).bind(
      workflowId,
      row.destination.id,
      attemptNumber,
      now,
      row.destination.id,
      attemptNumber
    )
  ]);
  if (results[0]?.meta.changes !== 1) {
    throw new AppError(
      409,
      "reconciliation_conflict",
      "The destination changed while reconciliation was being requested."
    );
  }
  await writeAuditEvent(db, {
    action: "destination.reconciliation_requested",
    actorUserId: auth.userId,
    entityId: row.destination.id,
    entityType: "publish_destination",
    metadata: { attemptNumber },
    workspaceId: auth.workspaceId
  });
  context.executionCtx.waitUntil(dispatchOutbox(context.env));
  await recomputePostStatus(context.env, row.destination.postId);
  return context.json(
    { post: await buildPost(db, row.destination.postId, auth.workspaceId) },
    202
  );
});
