import {
  deleteAccountSchema,
  retryDeletionSchema,
  type DeletionFailureCode,
  type DeletionPhase,
  type DeletionView
} from "@vidrelay/shared";
import { and, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { Hono } from "hono";

import type { AppEnv, Bindings } from "../env";
import { createDb } from "../db/client";
import {
  deletionRequests,
  memberships,
  socialConnections,
  uploads,
  users
} from "../db/schema";
import { deleteSessionCookie } from "../lib/cookies";
import { randomToken, sha256Base64Url, verifyPassword } from "../lib/crypto";
import { AppError, ProviderError } from "../lib/errors";
import { parseJson } from "../lib/json";
import { abortR2MultipartUpload } from "../lib/r2-s3";
import { safeLog } from "../lib/safe-logger";
import { requireAuth } from "../middleware/auth";
import { decodeCredentials } from "../platforms/credentials";
import { revokeProviderCredentials } from "../platforms/revoke";

const maximumAutomaticDeletionAttempts = 5;
const deletionLeaseMs = 15 * 60 * 1000;
const deletionRetryBaseMs = 5 * 60 * 1000;
const deletionRetryMaximumMs = 2 * 60 * 60 * 1000;

const deletionView = (
  row: typeof deletionRequests.$inferSelect
): DeletionView => ({
  actionRequired:
    row.status === "manual_review"
      ? "contact_support"
      : row.status === "complete"
        ? "none"
        : "wait",
  attemptCount: row.attemptCount,
  completedAt: row.completedAt,
  failureCode: row.failureCode,
  id: row.id,
  nextAttemptAt: row.nextAttemptAt,
  phase: row.phase,
  requestedAt: row.requestedAt,
  status: row.status,
  updatedAt: row.updatedAt
});

export const accountRoutes = new Hono<AppEnv>();
accountRoutes.use("*", requireAuth);

accountRoutes.get("/deletion", async context => {
  const auth = context.get("auth");
  const [row] = await createDb(context.env.DB)
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.workspaceId, auth.workspaceId))
    .orderBy(desc(deletionRequests.requestedAt))
    .limit(1);

  return context.json({
    deletion: row === undefined ? null : deletionView(row)
  });
});

accountRoutes.post("/deletion", async context => {
  const auth = context.get("auth");
  if (auth.role === "operator") {
    throw new AppError(
      409,
      "operator_account_deletion_requires_handoff",
      "Service operator accounts must be managed through controlled service administration."
    );
  }
  const input = await parseJson(context, deleteAccountSchema);
  const db = createDb(context.env.DB);
  const [account] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, auth.userId))
    .limit(1);
  if (
    account === undefined ||
    !(await verifyPassword(input.password, account.passwordHash))
  ) {
    throw new AppError(
      401,
      "invalid_password",
      "The current password is incorrect."
    );
  }

  const [membership] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, auth.userId),
        eq(memberships.workspaceId, auth.workspaceId)
      )
    )
    .limit(1);
  const [workspaceCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(memberships)
    .where(eq(memberships.workspaceId, auth.workspaceId));
  const [userMembershipCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(memberships)
    .where(eq(memberships.userId, auth.userId));
  if (
    membership?.role !== "owner" ||
    workspaceCount?.count !== 1 ||
    userMembershipCount?.count !== 1
  ) {
    throw new AppError(
      409,
      "account_deletion_requires_single_owner",
      "Account deletion is available only to the sole owner of a single-member workspace."
    );
  }

  const [activeRequest] = await db
    .select({ id: deletionRequests.id })
    .from(deletionRequests)
    .where(
      and(
        eq(deletionRequests.workspaceId, auth.workspaceId),
        inArray(deletionRequests.status, [
          "requested",
          "processing",
          "retry_scheduled",
          "manual_review"
        ])
      )
    )
    .limit(1);
  if (activeRequest !== undefined) {
    throw new AppError(
      409,
      "deletion_already_requested",
      "An account deletion request already exists."
    );
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const reference = randomToken(24);
  const confirmationReferenceHash = await sha256Base64Url(reference);
  const auditId = crypto.randomUUID();
  const deletionStarted = await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO deletion_requests (id, user_id, workspace_id, status, confirmation_reference_hash, requested_at, updated_at) SELECT ?, users.id, workspaces.id, 'requested', ?, ?, ? FROM users INNER JOIN memberships ON memberships.user_id = users.id INNER JOIN workspaces ON workspaces.id = memberships.workspace_id WHERE users.id = ? AND users.status = 'active' AND users.role = 'customer' AND workspaces.id = ? AND workspaces.status = 'active' AND memberships.role = 'owner' AND NOT EXISTS (SELECT 1 FROM memberships AS workspace_membership WHERE workspace_membership.workspace_id = workspaces.id AND workspace_membership.user_id <> users.id) AND NOT EXISTS (SELECT 1 FROM memberships AS user_membership WHERE user_membership.user_id = users.id AND user_membership.workspace_id <> workspaces.id) AND NOT EXISTS (SELECT 1 FROM deletion_requests AS active_deletion WHERE active_deletion.workspace_id = workspaces.id AND active_deletion.status IN ('requested', 'processing', 'retry_scheduled', 'manual_review'))"
    ).bind(
      id,
      confirmationReferenceHash,
      now,
      now,
      auth.userId,
      auth.workspaceId
    ),
    context.env.DB.prepare(
      "UPDATE users SET status = 'deletion_pending', updated_at = ? WHERE id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM deletion_requests WHERE id = ? AND user_id = users.id AND workspace_id = ? AND status = 'requested')"
    ).bind(now, auth.userId, id, auth.workspaceId),
    context.env.DB.prepare(
      "UPDATE workspaces SET status = 'deletion_pending', updated_at = ? WHERE id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM deletion_requests WHERE id = ? AND user_id = ? AND workspace_id = workspaces.id AND status = 'requested')"
    ).bind(now, auth.workspaceId, id, auth.userId),
    context.env.DB.prepare(
      "UPDATE publish_destinations SET status = CASE WHEN status IN ('queued', 'retry_scheduled') AND remote_session_id IS NULL AND remote_upload_url_encrypted IS NULL AND remote_post_id IS NULL AND remote_url IS NULL AND outcome_unknown = 0 AND stage <> 'provider_commit_started' THEN 'cancelled' ELSE 'reconciliation_required' END, stage = CASE WHEN status IN ('queued', 'retry_scheduled') AND remote_session_id IS NULL AND remote_upload_url_encrypted IS NULL AND remote_post_id IS NULL AND remote_url IS NULL AND outcome_unknown = 0 AND stage <> 'provider_commit_started' THEN 'account_deletion_requested' ELSE 'account_deletion_outcome_unknown' END, outcome_unknown = CASE WHEN status IN ('queued', 'retry_scheduled') AND remote_session_id IS NULL AND remote_upload_url_encrypted IS NULL AND remote_post_id IS NULL AND remote_url IS NULL AND outcome_unknown = 0 AND stage <> 'provider_commit_started' THEN 0 ELSE 1 END, next_poll_at = NULL, transition_token = ?, updated_at = ? WHERE post_id IN (SELECT id FROM posts WHERE workspace_id = ?) AND status NOT IN ('published', 'failed_permanent', 'reconciliation_required', 'cancelled') AND EXISTS (SELECT 1 FROM deletion_requests WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'requested')"
    ).bind(id, now, auth.workspaceId, id, auth.userId, auth.workspaceId),
    context.env.DB.prepare(
      "UPDATE publish_attempts SET status = (SELECT status FROM publish_destinations WHERE publish_destinations.id = publish_attempts.destination_id), stage = (SELECT stage FROM publish_destinations WHERE publish_destinations.id = publish_attempts.destination_id), finished_at = ?, updated_at = ? WHERE destination_id IN (SELECT publish_destinations.id FROM publish_destinations INNER JOIN posts ON posts.id = publish_destinations.post_id WHERE posts.workspace_id = ? AND publish_destinations.transition_token = ?) AND finished_at IS NULL AND EXISTS (SELECT 1 FROM deletion_requests WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'requested')"
    ).bind(now, now, auth.workspaceId, id, id, auth.userId, auth.workspaceId),
    context.env.DB.prepare(
      "UPDATE posts SET status = CASE WHEN NOT EXISTS (SELECT 1 FROM publish_destinations WHERE post_id = posts.id AND status <> 'published') THEN 'published' WHEN EXISTS (SELECT 1 FROM publish_destinations WHERE post_id = posts.id AND status = 'published') THEN 'partial_success' WHEN NOT EXISTS (SELECT 1 FROM publish_destinations WHERE post_id = posts.id AND status <> 'cancelled') THEN 'cancelled' ELSE 'failed' END, updated_at = ? WHERE workspace_id = ? AND EXISTS (SELECT 1 FROM publish_destinations WHERE publish_destinations.post_id = posts.id AND publish_destinations.transition_token = ?) AND EXISTS (SELECT 1 FROM deletion_requests WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'requested')"
    ).bind(now, auth.workspaceId, id, id, auth.userId, auth.workspaceId),
    context.env.DB.prepare(
      "DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM deletion_requests WHERE id = ? AND user_id = ? AND workspace_id = ? AND status = 'requested')"
    ).bind(auth.userId, id, auth.userId, auth.workspaceId),
    context.env.DB.prepare(
      "INSERT INTO audit_events (id, actor_user_id, workspace_id, action, entity_type, entity_id, metadata_json, created_at) SELECT ?, ?, ?, 'account.deletion_requested', 'deletion_request', ?, '{}', ? WHERE EXISTS (SELECT 1 FROM deletion_requests INNER JOIN users ON users.id = deletion_requests.user_id INNER JOIN workspaces ON workspaces.id = deletion_requests.workspace_id WHERE deletion_requests.id = ? AND deletion_requests.user_id = ? AND deletion_requests.workspace_id = ? AND deletion_requests.status = 'requested' AND users.status = 'deletion_pending' AND workspaces.status = 'deletion_pending')"
    ).bind(
      auditId,
      auth.userId,
      auth.workspaceId,
      id,
      now,
      id,
      auth.userId,
      auth.workspaceId
    )
  ]);
  if (deletionStarted[0]?.meta.changes !== 1) {
    throw new AppError(
      409,
      "account_deletion_changed",
      "The account changed before deletion could be requested."
    );
  }

  context.header("Set-Cookie", deleteSessionCookie(context.env));
  return context.json(
    {
      deletion: {
        actionRequired: "wait" as const,
        attemptCount: 0,
        completedAt: null,
        failureCode: null,
        id,
        nextAttemptAt: null,
        phase: "queued" as const,
        requestedAt: now,
        status: "requested" as const,
        updatedAt: now
      },
      reference
    },
    202
  );
});

accountRoutes.post("/deletions/:id/retry", async context => {
  const auth = context.get("auth");
  if (auth.role !== "operator") {
    throw new AppError(
      403,
      "operator_required",
      "Operator access is required."
    );
  }
  await parseJson(context, retryDeletionSchema);

  const db = createDb(context.env.DB);
  const [request] = await db
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.id, context.req.param("id")))
    .limit(1);
  if (request === undefined) {
    throw new AppError(
      404,
      "deletion_not_found",
      "The deletion request was not found."
    );
  }
  if (request.status !== "manual_review") {
    throw new AppError(
      409,
      "deletion_not_retryable",
      "Only a deletion request awaiting manual review can be retried."
    );
  }

  const now = Date.now();
  const auditId = crypto.randomUUID();
  const results = await context.env.DB.batch([
    context.env.DB.prepare(
      "UPDATE deletion_requests SET status = 'retry_scheduled', next_attempt_at = ?, failure_code = NULL, last_error = ?, updated_at = ? WHERE id = ? AND status = 'manual_review'"
    ).bind(now, auditId, now, request.id),
    context.env.DB.prepare(
      "INSERT INTO audit_events (id, actor_user_id, workspace_id, action, entity_type, entity_id, metadata_json, created_at) SELECT ?, ?, ?, 'account.deletion_retry_requested', 'deletion_request', ?, ?, ? WHERE EXISTS (SELECT 1 FROM deletion_requests WHERE id = ? AND status = 'retry_scheduled' AND last_error = ?)"
    ).bind(
      auditId,
      auth.userId,
      request.workspaceId,
      request.id,
      JSON.stringify({
        previousAttemptCount: request.attemptCount,
        previousFailureCode: request.failureCode
      }),
      now,
      request.id,
      auditId
    ),
    context.env.DB.prepare(
      "UPDATE deletion_requests SET last_error = NULL WHERE id = ? AND status = 'retry_scheduled' AND last_error = ?"
    ).bind(request.id, auditId)
  ]);
  if (
    results[0]?.meta.changes !== 1 ||
    results[1]?.meta.changes !== 1 ||
    results[2]?.meta.changes !== 1
  ) {
    throw new AppError(
      409,
      "deletion_changed",
      "The deletion request changed before it could be retried."
    );
  }

  const [updated] = await db
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.id, request.id))
    .limit(1);
  if (updated === undefined) {
    throw new AppError(
      404,
      "deletion_not_found",
      "The deletion request was not found."
    );
  }

  return context.json({ deletion: deletionView(updated) }, 202);
});

export const deletionStatusRoutes = new Hono<AppEnv>();
deletionStatusRoutes.get("/:reference", async context => {
  const reference = context.req.param("reference");
  if (reference.length < 24 || reference.length > 128) {
    throw new AppError(
      404,
      "deletion_not_found",
      "The deletion request was not found."
    );
  }
  const referenceHash = await sha256Base64Url(reference);
  const [row] = await createDb(context.env.DB)
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.confirmationReferenceHash, referenceHash))
    .limit(1);
  if (row === undefined) {
    throw new AppError(
      404,
      "deletion_not_found",
      "The deletion request was not found."
    );
  }

  return context.json({ deletion: deletionView(row) });
});

const revokeConnection = async (
  bindings: Bindings,
  row: typeof socialConnections.$inferSelect,
  deletingWorkspaceId: string,
  handledFacebookGrants: Set<string>,
  resumeAmbiguous: boolean
): Promise<void> => {
  if (row.status === "disconnected") {
    return;
  }
  if (row.lastErrorCode === "account_deletion_revoke_completed") {
    return;
  }
  if (
    resumeAmbiguous &&
    row.lastErrorCode?.startsWith("account_deletion_revoke_started")
  ) {
    throw new DeletionProcessingFailure(
      "provider_cleanup_failed",
      "A provider revocation started previously but its result was not recorded.",
      false
    );
  }
  if (row.provider === "tiktok") {
    const [sharedGrant] = await createDb(bindings.DB)
      .select({ id: socialConnections.id })
      .from(socialConnections)
      .where(
        and(
          eq(socialConnections.provider, "tiktok"),
          eq(socialConnections.remoteAccountId, row.remoteAccountId),
          inArray(socialConnections.status, [
            "connected",
            "limited",
            "reauth_required"
          ]),
          sql`${socialConnections.workspaceId} <> ${deletingWorkspaceId}`,
          sql`(${socialConnections.lastErrorCode} IS NULL OR (${socialConnections.lastErrorCode} NOT LIKE 'account_deletion_revoke_started%' AND ${socialConnections.lastErrorCode} <> 'account_deletion_revoke_completed' AND ${socialConnections.lastErrorCode} NOT LIKE 'disconnecting:%'))`,
          sql`EXISTS (SELECT 1 FROM workspaces INNER JOIN users ON users.id = ${socialConnections.connectedByUserId} WHERE workspaces.id = ${socialConnections.workspaceId} AND workspaces.status = 'active' AND users.status = 'active')`
        )
      )
      .limit(1);
    if (sharedGrant !== undefined) {
      return;
    }
  }

  const credentials = await decodeCredentials(
    bindings,
    row.credentialsEncrypted
  );
  if (row.provider === "facebook" && credentials.userAccessToken !== null) {
    let grantUserId: string | null = null;
    try {
      const metadata = JSON.parse(row.metadataJson) as Record<string, unknown>;
      grantUserId =
        typeof metadata.grantUserId === "string" &&
        metadata.grantUserId.length > 0
          ? metadata.grantUserId
          : null;
    } catch {
      grantUserId = null;
    }
    const grantKey =
      grantUserId === null
        ? "token:" + (await sha256Base64Url(credentials.userAccessToken))
        : "user:" + grantUserId;
    if (handledFacebookGrants.has(grantKey)) {
      return;
    }
    handledFacebookGrants.add(grantKey);

    const siblings = await createDb(bindings.DB)
      .select({
        credentialsEncrypted: socialConnections.credentialsEncrypted,
        metadataJson: socialConnections.metadataJson
      })
      .from(socialConnections)
      .where(
        and(
          eq(socialConnections.provider, "facebook"),
          inArray(socialConnections.status, ["connected", "limited"]),
          sql`${socialConnections.workspaceId} <> ${deletingWorkspaceId}`,
          sql`(${socialConnections.lastErrorCode} IS NULL OR (${socialConnections.lastErrorCode} NOT LIKE 'account_deletion_revoke_started%' AND ${socialConnections.lastErrorCode} <> 'account_deletion_revoke_completed' AND ${socialConnections.lastErrorCode} <> 'disconnecting' AND ${socialConnections.lastErrorCode} NOT LIKE 'disconnecting:%'))`,
          sql`EXISTS (SELECT 1 FROM workspaces INNER JOIN users ON users.id = ${socialConnections.connectedByUserId} WHERE workspaces.id = ${socialConnections.workspaceId} AND workspaces.status = 'active' AND users.status = 'active')`
        )
      );
    for (const sibling of siblings) {
      try {
        const siblingMetadata = JSON.parse(sibling.metadataJson) as Record<
          string,
          unknown
        >;
        if (
          grantUserId !== null &&
          siblingMetadata.grantUserId === grantUserId
        ) {
          return;
        }
        const siblingCredentials = await decodeCredentials(
          bindings,
          sibling.credentialsEncrypted
        );
        if (
          siblingCredentials.userAccessToken === credentials.userAccessToken
        ) {
          return;
        }
      } catch {
        continue;
      }
    }
  }
  await revokeProviderCredentials(bindings, row, credentials);
};

const deleteObjects = async (
  bindings: Bindings,
  keys: string[]
): Promise<void> => {
  for (let index = 0; index < keys.length; index += 1000) {
    await bindings.MEDIA.delete(keys.slice(index, index + 1000));
  }
};

const abortIncompleteUpload = async (
  bindings: Bindings,
  upload: {
    multipartUploadId: string | null;
    r2Key: string;
    status: typeof uploads.$inferSelect.status;
    uploadMode: typeof uploads.$inferSelect.uploadMode;
  }
): Promise<void> => {
  if (
    upload.multipartUploadId === null ||
    !["created", "uploading", "verifying"].includes(upload.status)
  ) {
    return;
  }
  if ((await bindings.MEDIA.head(upload.r2Key)) !== null) {
    return;
  }
  try {
    if (upload.uploadMode === "direct") {
      await abortR2MultipartUpload(
        bindings,
        upload.r2Key,
        upload.multipartUploadId
      );
      return;
    }
    await bindings.MEDIA.resumeMultipartUpload(
      upload.r2Key,
      upload.multipartUploadId
    ).abort();
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).toLowerCase();
    if (
      !message.includes("nosuchupload") &&
      !message.includes("not exist") &&
      !message.includes("404")
    ) {
      throw error;
    }
  }
};

class DeletionProcessingFailure extends Error {
  readonly failureCode: DeletionFailureCode;
  readonly retryable: boolean;

  constructor(
    failureCode: DeletionFailureCode,
    message: string,
    retryable = true
  ) {
    super(message);
    this.name = "DeletionProcessingFailure";
    this.failureCode = failureCode;
    this.retryable = retryable;
  }
}

class DeletionClaimLostError extends Error {
  constructor() {
    super("The deletion processing claim was superseded.");
    this.name = "DeletionClaimLostError";
  }
}

const failureCodeForPhase = (phase: DeletionPhase): DeletionFailureCode => {
  if (phase === "provider_cleanup") {
    return "provider_cleanup_failed";
  }
  if (phase === "media_cleanup") {
    return "media_cleanup_failed";
  }
  if (phase === "account_cleanup") {
    return "account_cleanup_failed";
  }
  return "deletion_processing_failed";
};

const failureMessage = (failureCode: DeletionFailureCode): string => {
  if (failureCode === "deletion_subject_missing") {
    return "The deletion subject requires operator review.";
  }
  if (failureCode === "provider_cleanup_failed") {
    return "Provider authorization cleanup did not complete.";
  }
  if (failureCode === "media_cleanup_failed") {
    return "Stored media cleanup did not complete.";
  }
  if (failureCode === "account_cleanup_failed") {
    return "Local account cleanup did not complete.";
  }
  if (failureCode === "deletion_interrupted") {
    return "Deletion processing stopped before the attempt completed.";
  }
  return "Account deletion processing did not complete.";
};

const deletionRetryDelay = (attemptCount: number): number =>
  Math.min(
    deletionRetryMaximumMs,
    deletionRetryBaseMs * 2 ** Math.max(0, attemptCount - 1)
  );

const advanceDeletionPhase = async (
  bindings: Bindings,
  requestId: string,
  attemptCount: number,
  phase: DeletionPhase
): Promise<void> => {
  const result = await bindings.DB.prepare(
    "UPDATE deletion_requests SET phase = ?, updated_at = ? WHERE id = ? AND status = 'processing' AND attempt_count = ?"
  )
    .bind(phase, Date.now(), requestId, attemptCount)
    .run();
  if (result.meta.changes !== 1) {
    throw new DeletionClaimLostError();
  }
};

export const processDeletionRequests = async (
  bindings: Bindings
): Promise<number> => {
  const now = Date.now();
  const retryCutoff = now - deletionLeaseMs;
  const db = createDb(bindings.DB);
  const requests = await db
    .select()
    .from(deletionRequests)
    .where(
      or(
        eq(deletionRequests.status, "requested"),
        and(
          eq(deletionRequests.status, "retry_scheduled"),
          lte(deletionRequests.nextAttemptAt, now)
        ),
        and(
          eq(deletionRequests.status, "processing"),
          lt(deletionRequests.updatedAt, retryCutoff)
        )
      )
    )
    .orderBy(deletionRequests.requestedAt)
    .limit(5);
  let completed = 0;

  for (const request of requests) {
    const claimNow = Date.now();
    const claimRetryCutoff = claimNow - deletionLeaseMs;
    if (request.status === "processing") {
      const terminal = request.attemptCount >= maximumAutomaticDeletionAttempts;
      const nextAttemptAt = terminal
        ? null
        : claimNow + deletionRetryDelay(request.attemptCount);
      const interrupted = await bindings.DB.prepare(
        "UPDATE deletion_requests SET status = ?, next_attempt_at = ?, failure_code = 'deletion_interrupted', last_error = 'Deletion processing stopped before the attempt completed.', updated_at = ? WHERE id = ? AND status = 'processing' AND attempt_count = ? AND updated_at < ?"
      )
        .bind(
          terminal ? "manual_review" : "retry_scheduled",
          nextAttemptAt,
          claimNow,
          request.id,
          request.attemptCount,
          claimRetryCutoff
        )
        .run();
      if (interrupted.meta.changes === 1) {
        safeLog("error", "account.deletion_interrupted", {
          attemptCount: request.attemptCount,
          deletionRequestId: request.id,
          nextAttemptAt,
          terminal
        });
      }
      continue;
    }
    const claim = await bindings.DB.prepare(
      "UPDATE deletion_requests SET status = 'processing', attempt_count = attempt_count + 1, next_attempt_at = NULL, phase = CASE WHEN status = 'requested' THEN 'provider_cleanup' ELSE phase END, failure_code = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND (status = 'requested' OR (status = 'retry_scheduled' AND next_attempt_at <= ?)) RETURNING attempt_count"
    )
      .bind(claimNow, request.id, claimNow)
      .first<{ attempt_count: number }>();
    if (claim === null) {
      continue;
    }
    const attemptCount = claim.attempt_count;
    let phase: DeletionPhase =
      request.status === "retry_scheduled" ? request.phase : "provider_cleanup";

    try {
      if (request.workspaceId === null || request.userId === null) {
        throw new DeletionProcessingFailure(
          "deletion_subject_missing",
          "The deletion request no longer references a complete account.",
          false
        );
      }
      if (phase === "provider_cleanup") {
        const connections = await db
          .select()
          .from(socialConnections)
          .where(eq(socialConnections.workspaceId, request.workspaceId));
        const handledFacebookGrants = new Set<string>();
        for (const connection of connections) {
          const revokeIntent =
            connection.provider === "tiktok"
              ? "account_deletion_revoke_started:" + crypto.randomUUID()
              : "account_deletion_revoke_started";
          if (
            connection.status !== "disconnected" &&
            !connection.lastErrorCode?.startsWith(
              "account_deletion_revoke_started"
            ) &&
            connection.lastErrorCode !== "account_deletion_revoke_completed"
          ) {
            const revokeClaimedAt = Date.now();
            const removalLeaseCutoff = revokeClaimedAt - deletionLeaseMs;
            const intent = await bindings.DB.prepare(
              "UPDATE social_connections SET last_error_code = ?, last_error_message = NULL, refresh_lease_id = NULL, refresh_lease_expires_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ? AND credentials_encrypted = ? AND status = ? AND (refresh_lease_id IS NULL OR refresh_lease_expires_at IS NULL OR refresh_lease_expires_at < ?) AND (last_error_code IS ? OR last_error_code = ?) AND (provider <> 'tiktok' OR NOT EXISTS (SELECT 1 FROM social_connections AS removing_connection WHERE removing_connection.provider = 'tiktok' AND removing_connection.remote_account_id = social_connections.remote_account_id AND removing_connection.id <> social_connections.id AND (removing_connection.last_error_code LIKE 'disconnecting:%' OR removing_connection.last_error_code LIKE 'account_deletion_revoke_started:%') AND removing_connection.updated_at >= ?))"
            )
              .bind(
                revokeIntent,
                revokeClaimedAt,
                connection.id,
                request.workspaceId,
                connection.credentialsEncrypted,
                connection.status,
                revokeClaimedAt,
                connection.lastErrorCode,
                connection.lastErrorCode,
                removalLeaseCutoff
              )
              .run();
            if (intent.meta.changes !== 1) {
              const latest = await bindings.DB.prepare(
                "SELECT credentials_encrypted, last_error_code, provider, refresh_lease_id, refresh_lease_expires_at, status, CASE WHEN provider = 'tiktok' AND EXISTS (SELECT 1 FROM social_connections AS removing_connection WHERE removing_connection.provider = 'tiktok' AND removing_connection.remote_account_id = social_connections.remote_account_id AND removing_connection.id <> social_connections.id AND (removing_connection.last_error_code LIKE 'disconnecting:%' OR removing_connection.last_error_code LIKE 'account_deletion_revoke_started:%') AND removing_connection.updated_at >= ?) THEN 1 ELSE 0 END AS tiktok_removal_locked FROM social_connections WHERE id = ? AND workspace_id = ? LIMIT 1"
              )
                .bind(removalLeaseCutoff, connection.id, request.workspaceId)
                .first<{
                  credentials_encrypted: string;
                  last_error_code: string | null;
                  provider: string;
                  refresh_lease_expires_at: number | null;
                  refresh_lease_id: string | null;
                  status: string;
                  tiktok_removal_locked: number;
                }>();
              const liveRefreshLease =
                latest !== null &&
                latest.refresh_lease_id !== null &&
                (latest.refresh_lease_expires_at === null ||
                  latest.refresh_lease_expires_at >= revokeClaimedAt);
              const unchangedTiktokConnection =
                latest !== null &&
                latest.provider === "tiktok" &&
                latest.credentials_encrypted ===
                  connection.credentialsEncrypted &&
                latest.status === connection.status &&
                latest.last_error_code === connection.lastErrorCode;
              throw new DeletionProcessingFailure(
                "provider_cleanup_failed",
                "Provider cleanup could not be claimed safely.",
                liveRefreshLease ||
                  latest?.tiktok_removal_locked === 1 ||
                  unchangedTiktokConnection
              );
            }
          }
          const newlyClaimed =
            connection.status !== "disconnected" &&
            !connection.lastErrorCode?.startsWith(
              "account_deletion_revoke_started"
            ) &&
            connection.lastErrorCode !== "account_deletion_revoke_completed";
          await revokeConnection(
            bindings,
            connection,
            request.workspaceId,
            handledFacebookGrants,
            !newlyClaimed
          );
          if (
            connection.status !== "disconnected" &&
            connection.lastErrorCode !== "account_deletion_revoke_completed"
          ) {
            const completedRevoke = await bindings.DB.prepare(
              "UPDATE social_connections SET last_error_code = 'account_deletion_revoke_completed', last_error_message = NULL, updated_at = ? WHERE id = ? AND workspace_id = ? AND status <> 'disconnected' AND last_error_code = ?"
            )
              .bind(
                Date.now(),
                connection.id,
                request.workspaceId,
                revokeIntent
              )
              .run();
            if (completedRevoke.meta.changes !== 1) {
              const latest = await bindings.DB.prepare(
                "SELECT status, last_error_code FROM social_connections WHERE id = ? AND workspace_id = ? LIMIT 1"
              )
                .bind(connection.id, request.workspaceId)
                .first<{ last_error_code: string | null; status: string }>();
              if (
                latest?.status === "disconnected" ||
                latest?.last_error_code === "account_deletion_revoke_completed"
              ) {
                continue;
              }
              throw new DeletionProcessingFailure(
                "provider_cleanup_failed",
                "Provider cleanup completed but its checkpoint could not be recorded.",
                false
              );
            }
          }
        }
        phase = "media_cleanup";
        await advanceDeletionPhase(bindings, request.id, attemptCount, phase);
      }

      if (phase === "media_cleanup") {
        const media = await db
          .select({
            multipartUploadId: uploads.multipartUploadId,
            r2Key: uploads.r2Key,
            status: uploads.status,
            uploadMode: uploads.uploadMode
          })
          .from(uploads)
          .where(eq(uploads.workspaceId, request.workspaceId));
        for (const upload of media) {
          await abortIncompleteUpload(bindings, upload);
        }
        await deleteObjects(
          bindings,
          media.map(item => item.r2Key)
        );

        phase = "account_cleanup";
        await advanceDeletionPhase(bindings, request.id, attemptCount, phase);
      }
      const completedAt = Date.now();
      const deletionResults = await bindings.DB.batch([
        bindings.DB.prepare(
          "DELETE FROM outbox_events WHERE ((event_type = 'publish_destination' AND aggregate_id IN (SELECT publish_destinations.id FROM publish_destinations INNER JOIN posts ON posts.id = publish_destinations.post_id WHERE posts.workspace_id = ?)) OR (event_type = 'delete_workspace' AND aggregate_id = ?)) AND EXISTS (SELECT 1 FROM deletion_requests WHERE id = ? AND status = 'processing' AND attempt_count = ? AND phase = 'account_cleanup')"
        ).bind(
          request.workspaceId,
          request.workspaceId,
          request.id,
          attemptCount
        ),
        bindings.DB.prepare(
          "DELETE FROM posts WHERE workspace_id = ? AND EXISTS (SELECT 1 FROM deletion_requests WHERE id = ? AND status = 'processing' AND attempt_count = ? AND phase = 'account_cleanup')"
        ).bind(request.workspaceId, request.id, attemptCount),
        bindings.DB.prepare(
          "DELETE FROM workspaces WHERE id = ? AND EXISTS (SELECT 1 FROM deletion_requests WHERE id = ? AND status = 'processing' AND attempt_count = ? AND phase = 'account_cleanup')"
        ).bind(request.workspaceId, request.id, attemptCount),
        bindings.DB.prepare(
          "DELETE FROM users WHERE id = ? AND EXISTS (SELECT 1 FROM deletion_requests WHERE id = ? AND status = 'processing' AND attempt_count = ? AND phase = 'account_cleanup')"
        ).bind(request.userId, request.id, attemptCount),
        bindings.DB.prepare(
          "UPDATE deletion_requests SET status = 'complete', next_attempt_at = NULL, phase = 'complete', failure_code = NULL, completed_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'processing' AND attempt_count = ? AND phase = 'account_cleanup'"
        ).bind(completedAt, completedAt, request.id, attemptCount)
      ]);
      if (
        deletionResults[2]?.meta.changes !== 1 ||
        deletionResults[3]?.meta.changes !== 1 ||
        deletionResults[4]?.meta.changes !== 1
      ) {
        throw new DeletionProcessingFailure(
          "account_cleanup_failed",
          "The account cleanup batch did not remove the expected workspace and user."
        );
      }
      completed += 1;
    } catch (error) {
      if (error instanceof DeletionClaimLostError) {
        safeLog("warn", "account.deletion_claim_lost", {
          attemptCount,
          deletionRequestId: request.id
        });
        continue;
      }
      const failureCode =
        error instanceof DeletionProcessingFailure
          ? error.failureCode
          : failureCodeForPhase(phase);
      const retryable =
        error instanceof DeletionProcessingFailure
          ? error.retryable
          : error instanceof ProviderError
            ? error.retryable || error.code === "reauth_required"
            : true;
      const terminal =
        !retryable || attemptCount >= maximumAutomaticDeletionAttempts;
      const failedAt = Date.now();
      const nextAttemptAt = terminal
        ? null
        : failedAt + deletionRetryDelay(attemptCount);
      const failureResult = await bindings.DB.prepare(
        "UPDATE deletion_requests SET status = ?, next_attempt_at = ?, failure_code = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'processing' AND attempt_count = ?"
      )
        .bind(
          terminal ? "manual_review" : "retry_scheduled",
          nextAttemptAt,
          failureCode,
          failureMessage(failureCode),
          failedAt,
          request.id,
          attemptCount
        )
        .run();
      if (failureResult.meta.changes !== 1) {
        safeLog("warn", "account.deletion_claim_lost", {
          attemptCount,
          deletionRequestId: request.id
        });
        continue;
      }
      safeLog("error", "account.deletion_failed", {
        attemptCount,
        deletionRequestId: request.id,
        failureCode,
        nextAttemptAt,
        terminal
      });
    }
  }

  return completed;
};
