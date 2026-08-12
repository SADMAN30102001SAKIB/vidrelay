import { deleteAccountSchema } from "@vidrelay/shared";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
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
import { AppError } from "../lib/errors";
import { parseJson } from "../lib/json";
import { abortR2MultipartUpload } from "../lib/r2-s3";
import { safeLog } from "../lib/safe-logger";
import { requireAuth } from "../middleware/auth";
import { decodeCredentials } from "../platforms/credentials";
import { revokeProviderCredentials } from "../platforms/revoke";

const deletionView = (row: typeof deletionRequests.$inferSelect) => ({
  completedAt: row.completedAt,
  id: row.id,
  requestedAt: row.requestedAt,
  status: row.status
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

  return context.json({ deletion: row === undefined ? null : deletionView(row) });
});

accountRoutes.post("/deletion", async context => {
  const auth = context.get("auth");
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
    throw new AppError(401, "invalid_password", "The current password is incorrect.");
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
        inArray(deletionRequests.status, ["requested", "processing", "failed"])
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
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO deletion_requests (id, user_id, workspace_id, status, confirmation_reference_hash, requested_at, updated_at) VALUES (?, ?, ?, 'requested', ?, ?, ?)"
    ).bind(
      id,
      auth.userId,
      auth.workspaceId,
      confirmationReferenceHash,
      now,
      now
    ),
    context.env.DB.prepare(
      "UPDATE users SET status = 'deletion_pending', updated_at = ? WHERE id = ?"
    ).bind(now, auth.userId),
    context.env.DB.prepare(
      "UPDATE workspaces SET status = 'deletion_pending', updated_at = ? WHERE id = ?"
    ).bind(now, auth.workspaceId),
    context.env.DB.prepare(
      "UPDATE publish_destinations SET status = 'cancelled', stage = 'account_deletion_requested', next_poll_at = NULL, updated_at = ? WHERE post_id IN (SELECT id FROM posts WHERE workspace_id = ?) AND status NOT IN ('published', 'failed_permanent', 'reconciliation_required', 'cancelled')"
    ).bind(now, auth.workspaceId),
    context.env.DB.prepare(
      "UPDATE publish_attempts SET status = 'cancelled', stage = 'account_deletion_requested', finished_at = ?, updated_at = ? WHERE destination_id IN (SELECT publish_destinations.id FROM publish_destinations INNER JOIN posts ON posts.id = publish_destinations.post_id WHERE posts.workspace_id = ?) AND finished_at IS NULL"
    ).bind(now, now, auth.workspaceId),
    context.env.DB.prepare(
      "UPDATE posts SET status = 'cancelled', updated_at = ? WHERE workspace_id = ? AND status NOT IN ('published', 'partial_success', 'failed', 'cancelled')"
    ).bind(now, auth.workspaceId),
    context.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(auth.userId),
    context.env.DB.prepare(
      "INSERT INTO audit_events (id, actor_user_id, workspace_id, action, entity_type, entity_id, metadata_json, created_at) VALUES (?, ?, ?, 'account.deletion_requested', 'deletion_request', ?, '{}', ?)"
    ).bind(auditId, auth.userId, auth.workspaceId, id, now)
  ]);

  context.header("Set-Cookie", deleteSessionCookie(context.env));
  return context.json(
    {
      deletion: {
        completedAt: null,
        id,
        requestedAt: now,
        status: "requested" as const
      },
      reference
    },
    202
  );
});

export const deletionStatusRoutes = new Hono<AppEnv>();
deletionStatusRoutes.get("/:reference", async context => {
  const reference = context.req.param("reference");
  if (reference.length < 24 || reference.length > 128) {
    throw new AppError(404, "deletion_not_found", "The deletion request was not found.");
  }
  const referenceHash = await sha256Base64Url(reference);
  const [row] = await createDb(context.env.DB)
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.confirmationReferenceHash, referenceHash))
    .limit(1);
  if (row === undefined) {
    throw new AppError(404, "deletion_not_found", "The deletion request was not found.");
  }

  return context.json({ deletion: deletionView(row) });
});

const revokeConnection = async (
  bindings: Bindings,
  row: typeof socialConnections.$inferSelect
): Promise<void> => {
  const credentials = await decodeCredentials(bindings, row.credentialsEncrypted);
  await revokeProviderCredentials(bindings, row, credentials);
};

const deleteObjects = async (bindings: Bindings, keys: string[]): Promise<void> => {
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
};

export const processDeletionRequests = async (bindings: Bindings): Promise<number> => {
  const now = Date.now();
  const retryCutoff = now - 15 * 60 * 1000;
  const db = createDb(bindings.DB);
  const requests = await db
    .select()
    .from(deletionRequests)
    .where(
      or(
        eq(deletionRequests.status, "requested"),
        and(
          inArray(deletionRequests.status, ["processing", "failed"]),
          lt(deletionRequests.updatedAt, retryCutoff)
        )
      )
    )
    .orderBy(deletionRequests.requestedAt)
    .limit(5);
  let completed = 0;

  for (const request of requests) {
    const claimed = await bindings.DB.prepare(
      "UPDATE deletion_requests SET status = 'processing', last_error = NULL, updated_at = ? WHERE id = ? AND (status = 'requested' OR (status IN ('processing', 'failed') AND updated_at < ?))"
    )
      .bind(now, request.id, retryCutoff)
      .run();
    if (claimed.meta.changes !== 1) {
      continue;
    }

    try {
      if (request.workspaceId === null || request.userId === null) {
        throw new Error("The deletion request no longer references an account.");
      }
      const connections = await db
        .select()
        .from(socialConnections)
        .where(eq(socialConnections.workspaceId, request.workspaceId));
      for (const connection of connections) {
        await revokeConnection(bindings, connection);
      }

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

      const completedAt = Date.now();
      await bindings.DB.batch([
        bindings.DB.prepare("DELETE FROM workspaces WHERE id = ?").bind(
          request.workspaceId
        ),
        bindings.DB.prepare("DELETE FROM users WHERE id = ?").bind(request.userId),
        bindings.DB.prepare(
          "UPDATE deletion_requests SET status = 'complete', completed_at = ?, last_error = NULL, updated_at = ? WHERE id = ?"
        ).bind(completedAt, completedAt, request.id)
      ]);
      completed += 1;
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 500) : "Account deletion failed.";
      await bindings.DB.prepare(
        "UPDATE deletion_requests SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?"
      )
        .bind(message, Date.now(), request.id)
        .run();
      safeLog("error", "account.deletion_failed", {
        deletionRequestId: request.id,
        error: message
      });
    }
  }

  return completed;
};
