import {
  uploadCompleteSchema,
  uploadCreateSchema,
  uploadPartRequestSchema
} from "@vidrelay/shared";
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { Hono } from "hono";

import type { AppEnv, Bindings } from "../env";
import { createDb, type Database } from "../db/client";
import { uploads } from "../db/schema";
import { writeAuditEvent } from "../lib/audit";
import { AppError } from "../lib/errors";
import { parseJson } from "../lib/json";
import { inspectMp4 } from "../lib/mp4";
import { toUpload, validationFrom } from "../lib/mappers";
import {
  abortR2MultipartUpload,
  completeR2MultipartUpload,
  createR2MultipartUpload,
  presignR2UploadPart
} from "../lib/r2-s3";
import { safeLog } from "../lib/safe-logger";
import { requireAuth } from "../middleware/auth";

const partSize = 16 * 1024 * 1024;
const maxWorkspaceStorageBytes = 10 * 1024 * 1024 * 1024;
const maxWorkspaceActiveUploads = 20;
const verificationLeaseMs = 5 * 60 * 1000;

const isMissingMultipartError = (error: unknown): boolean => {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    message.includes("nosuchupload") ||
    message.includes("not exist") ||
    message.includes("404")
  );
};

const abortMultipart = async (
  bindings: Bindings,
  input: {
    key: string;
    mode: "direct" | "worker_proxy";
    uploadId: string;
  }
): Promise<void> => {
  try {
    if (input.mode === "direct") {
      await abortR2MultipartUpload(bindings, input.key, input.uploadId);
    } else {
      await bindings.MEDIA.resumeMultipartUpload(
        input.key,
        input.uploadId
      ).abort();
    }
  } catch (error) {
    if (!isMissingMultipartError(error)) {
      throw error;
    }
  }
};

const abortIncompleteMultipart = async (
  bindings: Bindings,
  input: {
    key: string;
    mode: "direct" | "worker_proxy";
    uploadId: string;
  }
): Promise<void> => {
  if ((await bindings.MEDIA.head(input.key)) === null) {
    await abortMultipart(bindings, input);
  }
};

const abandonMultipartStart = async (
  bindings: Bindings,
  input: {
    id: string;
    key: string;
    mode: "direct" | "worker_proxy";
    requestId: string;
    uploadId: string;
    workspaceId: string;
  }
): Promise<void> => {
  try {
    await bindings.DB.prepare(
      "UPDATE uploads SET multipart_upload_id = COALESCE(multipart_upload_id, ?), status = 'aborted', storage_deleted_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ? AND status IN ('created', 'aborted') AND (multipart_upload_id IS NULL OR multipart_upload_id = ?)"
    )
      .bind(
        input.uploadId,
        Date.now(),
        input.id,
        input.workspaceId,
        input.uploadId
      )
      .run();
  } catch (error) {
    safeLog("error", "upload.multipart_tracking_recovery_failed", {
      error: error instanceof Error ? error.message : "unknown",
      requestId: input.requestId,
      uploadId: input.id
    });
  }

  try {
    await abortMultipart(bindings, input);
  } catch (error) {
    safeLog("warn", "upload.multipart_abort_failed", {
      error: error instanceof Error ? error.message : "unknown",
      requestId: input.requestId,
      uploadId: input.id
    });
  }
};

const deleteStoredObject = async (
  db: Database,
  bucket: R2Bucket,
  row: Pick<typeof uploads.$inferSelect, "id" | "r2Key" | "workspaceId">
): Promise<boolean> => {
  try {
    await bucket.delete(row.r2Key);
  } catch (error) {
    safeLog("warn", "upload.object_delete_failed", {
      error: error instanceof Error ? error.message : "unknown",
      uploadId: row.id
    });
    return false;
  }

  try {
    const [updated] = await db
      .update(uploads)
      .set({ storageDeletedAt: Date.now(), updatedAt: Date.now() })
      .where(
        and(eq(uploads.id, row.id), eq(uploads.workspaceId, row.workspaceId))
      )
      .returning({ id: uploads.id });
    if (updated !== undefined) {
      return true;
    }
    safeLog("warn", "upload.object_delete_marker_failed", {
      uploadId: row.id
    });
  } catch (error) {
    safeLog("warn", "upload.object_delete_marker_failed", {
      error: error instanceof Error ? error.message : "unknown",
      uploadId: row.id
    });
  }
  return false;
};

const findUpload = async (
  db: Database,
  id: string,
  workspaceId: string
): Promise<typeof uploads.$inferSelect> => {
  const [row] = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, id), eq(uploads.workspaceId, workspaceId)))
    .limit(1);
  if (row === undefined) {
    throw new AppError(404, "upload_not_found", "The upload was not found.");
  }
  return row;
};

const expectedPartCount = (size: number, bytesPerPart: number): number =>
  Math.ceil(size / bytesPerPart);

const validatePartList = (
  row: typeof uploads.$inferSelect,
  parts: { etag: string; partNumber: number }[]
): { etag: string; partNumber: number }[] => {
  const sorted = parts
    .slice()
    .sort((left, right) => left.partNumber - right.partNumber);
  const count = expectedPartCount(row.expectedSize, row.partSize);
  if (
    sorted.length !== count ||
    sorted.some((part, index) => part.partNumber !== index + 1) ||
    new Set(sorted.map(part => part.partNumber)).size !== sorted.length
  ) {
    throw new AppError(
      422,
      "invalid_part_manifest",
      "The completed part manifest is incomplete or out of order."
    );
  }
  return sorted;
};

const finalizeInspection = async (
  db: Database,
  bucket: R2Bucket,
  row: typeof uploads.$inferSelect,
  claimVersion: number
): Promise<typeof uploads.$inferSelect> => {
  const object = await bucket.head(row.r2Key);
  if (object === null) {
    throw new AppError(
      409,
      "object_not_ready",
      "The uploaded object is not available yet."
    );
  }

  if (object.size !== row.expectedSize) {
    const errors = [
      "Uploaded size does not match the declared file size. Start a new upload."
    ];
    const [rejected] = await db
      .update(uploads)
      .set({
        actualSize: object.size,
        status: "rejected",
        updatedAt: Date.now(),
        validationJson: JSON.stringify({ errors, warnings: [] })
      })
      .where(
        and(
          eq(uploads.id, row.id),
          eq(uploads.workspaceId, row.workspaceId),
          eq(uploads.status, "verifying"),
          eq(uploads.updatedAt, claimVersion)
        )
      )
      .returning({ id: uploads.id });
    if (rejected !== undefined) {
      await deleteStoredObject(db, bucket, row);
      return await findUpload(db, row.id, row.workspaceId);
    }
    const current = await findUpload(db, row.id, row.workspaceId);
    if (current.status === "ready" || current.status === "rejected") {
      return current;
    }
    throw new AppError(
      409,
      "upload_verification_interrupted",
      "Upload verification was superseded. Check the upload status before retrying."
    );
  }

  const inspection = await inspectMp4(bucket, row.r2Key, object.size);
  const now = Date.now();
  const [finalized] = await db
    .update(uploads)
    .set({
      actualSize: object.size,
      audioCodec: inspection.audioCodec,
      completedAt: now,
      durationMs: inspection.durationMs,
      fpsMilli:
        inspection.fps === null ? null : Math.round(inspection.fps * 1000),
      height: inspection.height,
      status: inspection.errors.length === 0 ? "ready" : "rejected",
      updatedAt: now,
      validationJson: JSON.stringify({
        errors: inspection.errors,
        warnings: inspection.warnings
      }),
      videoCodec: inspection.videoCodec,
      width: inspection.width
    })
    .where(
      and(
        eq(uploads.id, row.id),
        eq(uploads.workspaceId, row.workspaceId),
        eq(uploads.status, "verifying"),
        eq(uploads.updatedAt, claimVersion)
      )
    )
    .returning({ id: uploads.id });
  if (finalized === undefined) {
    const current = await findUpload(db, row.id, row.workspaceId);
    if (current.status === "ready" || current.status === "rejected") {
      return current;
    }
    throw new AppError(
      409,
      "upload_verification_interrupted",
      "Upload verification was superseded. Check the upload status before retrying."
    );
  }
  if (inspection.errors.length > 0) {
    await deleteStoredObject(db, bucket, row);
  }
  return await findUpload(db, row.id, row.workspaceId);
};

export const uploadRoutes = new Hono<AppEnv>();
uploadRoutes.use("*", requireAuth);

uploadRoutes.get("/", async context => {
  const auth = context.get("auth");
  const rows = await createDb(context.env.DB)
    .select()
    .from(uploads)
    .where(eq(uploads.workspaceId, auth.workspaceId))
    .orderBy(desc(uploads.createdAt))
    .limit(50);
  return context.json({ uploads: rows.map(toUpload) });
});

uploadRoutes.get("/:id", async context => {
  const auth = context.get("auth");
  return context.json({
    upload: toUpload(
      await findUpload(
        createDb(context.env.DB),
        context.req.param("id"),
        auth.workspaceId
      )
    )
  });
});

uploadRoutes.post("/", async context => {
  const auth = context.get("auth");
  const input = await parseJson(context, uploadCreateSchema);
  const id = crypto.randomUUID();
  const key = "workspaces/" + auth.workspaceId + "/uploads/" + id + ".mp4";
  const mode = context.env.UPLOAD_MODE;
  const now = Date.now();
  const db = createDb(context.env.DB);
  const insertStatement = context.env.DB.prepare(
    "INSERT INTO uploads (id, workspace_id, created_by_user_id, r2_key, filename, mime_type, expected_size, actual_size, upload_mode, multipart_upload_id, part_size, status, validation_json, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, 'created', '{\"errors\":[],\"warnings\":[]}', ?, ? WHERE EXISTS (SELECT 1 FROM users INNER JOIN memberships ON memberships.user_id = users.id INNER JOIN workspaces ON workspaces.id = memberships.workspace_id WHERE users.id = ? AND users.status = 'active' AND workspaces.id = memberships.workspace_id AND workspaces.id = ? AND workspaces.status = 'active') AND (SELECT count(*) FROM uploads WHERE workspace_id = ? AND status IN ('created', 'uploading', 'verifying')) < ? AND COALESCE((SELECT sum(expected_size) FROM uploads WHERE workspace_id = ? AND storage_deleted_at IS NULL), 0) + ? <= ?"
  ).bind(
    id,
    auth.workspaceId,
    auth.userId,
    key,
    input.filename,
    input.mimeType,
    input.size,
    mode,
    partSize,
    now,
    now,
    auth.userId,
    auth.workspaceId,
    auth.workspaceId,
    maxWorkspaceActiveUploads,
    auth.workspaceId,
    input.size,
    maxWorkspaceStorageBytes
  );
  const inserted = await insertStatement.run();
  if (inserted.meta.changes !== 1) {
    throw new AppError(
      409,
      "upload_quota_exceeded",
      "The workspace active-upload or stored-media limit was reached, or the account is no longer active. Remove unused videos or contact the operator about retention."
    );
  }

  let multipartUploadId: string;
  try {
    if (mode === "direct") {
      multipartUploadId = await createR2MultipartUpload(context.env, key);
    } else {
      const multipart = await context.env.MEDIA.createMultipartUpload(key, {
        httpMetadata: { contentType: input.mimeType }
      });
      multipartUploadId = multipart.uploadId;
    }
  } catch (error) {
    try {
      await db
        .update(uploads)
        .set({ status: "aborted", updatedAt: Date.now() })
        .where(
          and(
            eq(uploads.id, id),
            eq(uploads.workspaceId, auth.workspaceId),
            eq(uploads.status, "created")
          )
        );
    } catch (reservationError) {
      safeLog("error", "upload.reservation_abort_failed", {
        error:
          reservationError instanceof Error
            ? reservationError.message
            : "unknown",
        requestId: context.get("requestId"),
        uploadId: id
      });
    }
    safeLog("error", "upload.multipart_create_failed", {
      error: error instanceof Error ? error.message : "unknown",
      requestId: context.get("requestId"),
      uploadId: id
    });
    throw new AppError(
      503,
      "upload_storage_unavailable",
      "The upload could not be started. Try again shortly."
    );
  }

  let trackedChanges: number;
  try {
    const tracked = await context.env.DB.prepare(
      "UPDATE uploads SET multipart_upload_id = ?, storage_deleted_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ? AND multipart_upload_id IS NULL AND status IN ('created', 'aborted')"
    )
      .bind(multipartUploadId, Date.now(), id, auth.workspaceId)
      .run();
    trackedChanges = tracked.meta.changes;
  } catch (error) {
    await abandonMultipartStart(context.env, {
      id,
      key,
      mode,
      requestId: context.get("requestId"),
      uploadId: multipartUploadId,
      workspaceId: auth.workspaceId
    });
    safeLog("error", "upload.multipart_tracking_failed", {
      error: error instanceof Error ? error.message : "unknown",
      requestId: context.get("requestId"),
      uploadId: id
    });
    throw new AppError(
      503,
      "upload_storage_unavailable",
      "The upload could not be started. Try again shortly."
    );
  }
  if (trackedChanges !== 1) {
    await abandonMultipartStart(context.env, {
      id,
      key,
      mode,
      requestId: context.get("requestId"),
      uploadId: multipartUploadId,
      workspaceId: auth.workspaceId
    });
    throw new AppError(
      409,
      "upload_start_interrupted",
      "The upload reservation changed before storage was ready. Start a new upload."
    );
  }

  let activatedChanges: number;
  try {
    const activated = await context.env.DB.prepare(
      "UPDATE uploads SET status = 'uploading', updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'created' AND multipart_upload_id = ? AND EXISTS (SELECT 1 FROM users INNER JOIN memberships ON memberships.user_id = users.id INNER JOIN workspaces ON workspaces.id = memberships.workspace_id WHERE users.id = ? AND users.status = 'active' AND workspaces.id = memberships.workspace_id AND workspaces.id = ? AND workspaces.status = 'active')"
    )
      .bind(
        Date.now(),
        id,
        auth.workspaceId,
        multipartUploadId,
        auth.userId,
        auth.workspaceId
      )
      .run();
    activatedChanges = activated.meta.changes;
  } catch (error) {
    await abandonMultipartStart(context.env, {
      id,
      key,
      mode,
      requestId: context.get("requestId"),
      uploadId: multipartUploadId,
      workspaceId: auth.workspaceId
    });
    safeLog("error", "upload.activation_failed", {
      error: error instanceof Error ? error.message : "unknown",
      requestId: context.get("requestId"),
      uploadId: id
    });
    throw new AppError(
      503,
      "upload_storage_unavailable",
      "The upload could not be started. Try again shortly."
    );
  }
  if (activatedChanges !== 1) {
    await abandonMultipartStart(context.env, {
      id,
      key,
      mode,
      requestId: context.get("requestId"),
      uploadId: multipartUploadId,
      workspaceId: auth.workspaceId
    });
    throw new AppError(
      409,
      "upload_start_interrupted",
      "The upload reservation changed before storage was ready. Start a new upload."
    );
  }
  await writeAuditEvent(db, {
    action: "upload.created",
    actorUserId: auth.userId,
    entityId: id,
    entityType: "upload",
    metadata: { mode, size: input.size },
    workspaceId: auth.workspaceId
  });
  const row = await findUpload(db, id, auth.workspaceId);

  return context.json(
    {
      multipart: {
        mode,
        partCount: expectedPartCount(input.size, partSize),
        partSize
      },
      upload: toUpload(row)
    },
    201
  );
});

uploadRoutes.post("/:id/parts", async context => {
  const auth = context.get("auth");
  const input = await parseJson(context, uploadPartRequestSchema);
  const db = createDb(context.env.DB);
  const row = await findUpload(db, context.req.param("id"), auth.workspaceId);
  if (row.status !== "uploading" || row.multipartUploadId === null) {
    throw new AppError(
      409,
      "upload_not_active",
      "This upload is not accepting parts."
    );
  }

  const count = expectedPartCount(row.expectedSize, row.partSize);
  if (input.partNumbers.some(number => number > count)) {
    throw new AppError(
      422,
      "invalid_part_number",
      "A requested part number is out of range."
    );
  }

  const expiresAt = Date.now() + 15 * 60 * 1000;
  const parts = await Promise.all(
    input.partNumbers.map(async number => ({
      number,
      url:
        row.uploadMode === "direct"
          ? await presignR2UploadPart(context.env, {
              contentLength:
                number === count
                  ? row.expectedSize - row.partSize * (count - 1)
                  : row.partSize,
              expiresSeconds: 15 * 60,
              key: row.r2Key,
              multipartUploadId: row.multipartUploadId ?? "",
              partNumber: number
            })
          : new URL(
              "/api/uploads/" + row.id + "/parts/" + String(number),
              context.env.PUBLIC_API_ORIGIN
            ).toString()
    }))
  );
  return context.json({ expiresAt, mode: row.uploadMode, parts });
});

uploadRoutes.put("/:id/parts/:partNumber", async context => {
  const auth = context.get("auth");
  const partNumber = Number(context.req.param("partNumber"));
  const db = createDb(context.env.DB);
  const row = await findUpload(db, context.req.param("id"), auth.workspaceId);
  if (
    row.uploadMode !== "worker_proxy" ||
    row.status !== "uploading" ||
    row.multipartUploadId === null
  ) {
    throw new AppError(
      409,
      "proxy_upload_unavailable",
      "This proxy part upload is unavailable."
    );
  }

  const count = expectedPartCount(row.expectedSize, row.partSize);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) {
    throw new AppError(
      422,
      "invalid_part_number",
      "The part number is out of range."
    );
  }
  const expectedLength =
    partNumber === count
      ? row.expectedSize - row.partSize * (count - 1)
      : row.partSize;
  const contentLength = Number(context.req.header("Content-Length"));
  if (!Number.isFinite(contentLength) || contentLength !== expectedLength) {
    throw new AppError(
      422,
      "invalid_part_size",
      "The uploaded part does not match the expected byte length."
    );
  }
  if (context.req.raw.body === null) {
    throw new AppError(
      400,
      "missing_part_body",
      "The upload part body is missing."
    );
  }

  const multipart = context.env.MEDIA.resumeMultipartUpload(
    row.r2Key,
    row.multipartUploadId
  );
  const part = await multipart.uploadPart(partNumber, context.req.raw.body);
  return context.json({ etag: part.etag, partNumber });
});

uploadRoutes.post("/:id/complete", async context => {
  const auth = context.get("auth");
  const input = await parseJson(context, uploadCompleteSchema);
  const db = createDb(context.env.DB);
  let row = await findUpload(db, context.req.param("id"), auth.workspaceId);
  if (row.status === "ready" || row.status === "rejected") {
    return context.json({ upload: toUpload(row) });
  }
  if (
    (row.status !== "uploading" && row.status !== "verifying") ||
    row.multipartUploadId === null
  ) {
    throw new AppError(
      409,
      "upload_not_completable",
      "This upload cannot be completed."
    );
  }
  const parts = validatePartList(row, input.parts);

  const claimVersion = Date.now();
  if (
    row.status === "verifying" &&
    row.updatedAt > claimVersion - verificationLeaseMs
  ) {
    throw new AppError(
      409,
      "upload_verification_in_progress",
      "This upload is already being verified. Check its status shortly."
    );
  }
  const claimed = await context.env.DB.prepare(
    "UPDATE uploads SET status = 'verifying', updated_at = ? WHERE id = ? AND workspace_id = ? AND status = ? AND updated_at = ?"
  )
    .bind(claimVersion, row.id, auth.workspaceId, row.status, row.updatedAt)
    .run();
  if (claimed.meta.changes !== 1) {
    row = await findUpload(db, row.id, auth.workspaceId);
    if (row.status === "ready" || row.status === "rejected") {
      return context.json({ upload: toUpload(row) });
    }
    throw new AppError(
      409,
      "upload_verification_in_progress",
      "This upload is already being verified. Check its status shortly."
    );
  }
  row = { ...row, status: "verifying", updatedAt: claimVersion };

  const existing = await context.env.MEDIA.head(row.r2Key);
  if (existing === null) {
    try {
      if (row.uploadMode === "direct") {
        await completeR2MultipartUpload(context.env, {
          key: row.r2Key,
          multipartUploadId: row.multipartUploadId,
          parts
        });
      } else {
        await context.env.MEDIA.resumeMultipartUpload(
          row.r2Key,
          row.multipartUploadId
        ).complete(parts);
      }
    } catch (error) {
      const afterFailure = await context.env.MEDIA.head(row.r2Key);
      if (afterFailure === null) {
        await db
          .update(uploads)
          .set({ status: "uploading", updatedAt: Date.now() })
          .where(
            and(
              eq(uploads.id, row.id),
              eq(uploads.workspaceId, auth.workspaceId),
              eq(uploads.status, "verifying"),
              eq(uploads.updatedAt, claimVersion)
            )
          );
        safeLog("warn", "upload.multipart_complete_failed", {
          error: error instanceof Error ? error.message : "unknown",
          requestId: context.get("requestId"),
          uploadId: row.id
        });
        throw new AppError(
          503,
          "upload_completion_failed",
          "The upload could not be completed. It is safe to retry."
        );
      }
    }
  }

  row = await finalizeInspection(db, context.env.MEDIA, row, claimVersion);
  await writeAuditEvent(db, {
    action: row.status === "ready" ? "upload.verified" : "upload.rejected",
    actorUserId: auth.userId,
    entityId: row.id,
    entityType: "upload",
    metadata: { validation: validationFrom(row.validationJson) },
    workspaceId: auth.workspaceId
  });
  return context.json({ upload: toUpload(row) });
});

uploadRoutes.delete("/:id", async context => {
  const auth = context.get("auth");
  const db = createDb(context.env.DB);
  const row = await findUpload(db, context.req.param("id"), auth.workspaceId);
  if (row.status === "aborted") {
    if (row.storageDeletedAt !== null) {
      return context.body(null, 204);
    }
    if (row.multipartUploadId !== null) {
      try {
        await abortIncompleteMultipart(context.env, {
          key: row.r2Key,
          mode: row.uploadMode,
          uploadId: row.multipartUploadId
        });
      } catch (error) {
        safeLog("warn", "upload.multipart_abort_failed", {
          error: error instanceof Error ? error.message : "unknown",
          requestId: context.get("requestId"),
          uploadId: row.id
        });
        return context.body(null, 202);
      }
    }
    if (await deleteStoredObject(db, context.env.MEDIA, row)) {
      return context.body(null, 204);
    }
    return context.body(null, 202);
  }
  const claimed = await context.env.DB.prepare(
    "UPDATE uploads SET status = 'aborted', updated_at = ? WHERE id = ? AND workspace_id = ? AND status NOT IN ('aborted', 'created', 'verifying') AND (NOT EXISTS (SELECT 1 FROM posts WHERE posts.upload_id = uploads.id) OR (uploads.status = 'ready' AND NOT EXISTS (SELECT 1 FROM posts AS referenced_posts WHERE referenced_posts.upload_id = uploads.id AND (NOT EXISTS (SELECT 1 FROM publish_destinations WHERE publish_destinations.post_id = referenced_posts.id) OR EXISTS (SELECT 1 FROM publish_destinations WHERE publish_destinations.post_id = referenced_posts.id AND publish_destinations.status NOT IN ('published', 'cancelled'))))))"
  )
    .bind(Date.now(), row.id, auth.workspaceId)
    .run();
  if (claimed.meta.changes !== 1) {
    const current = await findUpload(db, row.id, auth.workspaceId);
    if (current.status === "aborted") {
      if (current.storageDeletedAt !== null) {
        return context.body(null, 204);
      }
      return context.body(null, 202);
    }
    if (current.status === "verifying") {
      throw new AppError(
        409,
        "upload_verification_in_progress",
        "This upload is being verified and cannot be removed yet."
      );
    }
    if (current.status === "created") {
      throw new AppError(
        409,
        "upload_start_in_progress",
        "Storage is still being prepared for this upload. Try again shortly."
      );
    }
    throw new AppError(
      409,
      "upload_in_use",
      "This video is attached to a post."
    );
  }

  let cleanupComplete = row.storageDeletedAt !== null;
  let multipartClosed = true;
  if (
    !cleanupComplete &&
    row.multipartUploadId !== null &&
    row.status === "uploading"
  ) {
    try {
      await abortIncompleteMultipart(context.env, {
        key: row.r2Key,
        mode: row.uploadMode,
        uploadId: row.multipartUploadId
      });
    } catch (error) {
      safeLog("warn", "upload.multipart_abort_failed", {
        error: error instanceof Error ? error.message : "unknown",
        requestId: context.get("requestId"),
        uploadId: row.id
      });
      multipartClosed = false;
    }
  }
  if (!cleanupComplete && multipartClosed) {
    cleanupComplete = await deleteStoredObject(db, context.env.MEDIA, row);
  }
  await writeAuditEvent(db, {
    action: "upload.aborted",
    actorUserId: auth.userId,
    entityId: row.id,
    entityType: "upload",
    workspaceId: auth.workspaceId
  });
  if (cleanupComplete) {
    return context.body(null, 204);
  }
  return context.body(null, 202);
});

export const cleanupUploads = async (bindings: Bindings): Promise<number> => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const db = createDb(bindings.DB);
  const rows = await db
    .select()
    .from(uploads)
    .where(
      or(
        and(
          inArray(uploads.status, ["rejected", "aborted"]),
          isNull(uploads.storageDeletedAt)
        ),
        and(
          inArray(uploads.status, ["created", "uploading", "verifying"]),
          lt(uploads.updatedAt, cutoff)
        )
      )
    )
    .orderBy(uploads.updatedAt)
    .limit(20);
  let cleaned = 0;
  for (const row of rows) {
    try {
      if (["created", "uploading", "verifying"].includes(row.status)) {
        const claimed = await bindings.DB.prepare(
          "UPDATE uploads SET status = 'aborted', updated_at = ? WHERE id = ? AND status = ? AND updated_at = ? AND updated_at < ?"
        )
          .bind(Date.now(), row.id, row.status, row.updatedAt, cutoff)
          .run();
        if (claimed.meta.changes !== 1) {
          continue;
        }
      }
      if (
        row.multipartUploadId !== null &&
        ["aborted", "created", "uploading", "verifying"].includes(row.status)
      ) {
        await abortIncompleteMultipart(bindings, {
          key: row.r2Key,
          mode: row.uploadMode,
          uploadId: row.multipartUploadId
        });
      }
      if (await deleteStoredObject(db, bindings.MEDIA, row)) {
        cleaned += 1;
      }
    } catch (error) {
      safeLog("warn", "upload.cleanup_failed", {
        error: error instanceof Error ? error.message : "unknown",
        uploadId: row.id
      });
    }
  }
  return cleaned;
};
