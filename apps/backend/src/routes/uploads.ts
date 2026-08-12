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
const maxWorkspaceUploads = 20;

const isMissingMultipartError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("NoSuchUpload") || message.includes("404");
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
      await bindings.MEDIA.resumeMultipartUpload(input.key, input.uploadId).abort();
    }
  } catch (error) {
    if (!isMissingMultipartError(error)) {
      throw error;
    }
  }
};

const deleteStoredObject = async (
  db: Database,
  bucket: R2Bucket,
  row: Pick<typeof uploads.$inferSelect, "id" | "r2Key">
): Promise<void> => {
  try {
    await bucket.delete(row.r2Key);
    await db
      .update(uploads)
      .set({ storageDeletedAt: Date.now(), updatedAt: Date.now() })
      .where(eq(uploads.id, row.id));
  } catch (error) {
    safeLog("warn", "upload.object_delete_failed", {
      error: error instanceof Error ? error.message : "unknown",
      uploadId: row.id
    });
  }
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
  const sorted = parts.slice().sort((left, right) => left.partNumber - right.partNumber);
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
  row: typeof uploads.$inferSelect
): Promise<typeof uploads.$inferSelect> => {
  const object = await bucket.head(row.r2Key);
  if (object === null) {
    throw new AppError(409, "object_not_ready", "The uploaded object is not available yet.");
  }

  if (object.size !== row.expectedSize) {
    const errors = [
      "Uploaded size does not match the declared file size. Start a new upload."
    ];
    await db
      .update(uploads)
      .set({
        actualSize: object.size,
        status: "rejected",
        updatedAt: Date.now(),
        validationJson: JSON.stringify({ errors, warnings: [] })
      })
      .where(eq(uploads.id, row.id));
    await deleteStoredObject(db, bucket, row);
    return await findUpload(db, row.id, row.workspaceId);
  }

  const inspection = await inspectMp4(bucket, row.r2Key, object.size);
  const now = Date.now();
  await db
    .update(uploads)
    .set({
      actualSize: object.size,
      audioCodec: inspection.audioCodec,
      completedAt: now,
      durationMs: inspection.durationMs,
      fpsMilli: inspection.fps === null ? null : Math.round(inspection.fps * 1000),
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
    .where(eq(uploads.id, row.id));
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
      await findUpload(createDb(context.env.DB), context.req.param("id"), auth.workspaceId)
    )
  });
});

uploadRoutes.post("/", async context => {
  const auth = context.get("auth");
  const input = await parseJson(context, uploadCreateSchema);
  const id = crypto.randomUUID();
  const key = "workspaces/" + auth.workspaceId + "/uploads/" + id + ".mp4";
  const mode = context.env.UPLOAD_MODE;
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
    safeLog("error", "upload.multipart_create_failed", {
      error: error instanceof Error ? error.message : "unknown",
      requestId: context.get("requestId")
    });
    throw new AppError(
      503,
      "upload_storage_unavailable",
      "The upload could not be started. Try again shortly."
    );
  }

  const now = Date.now();
  const db = createDb(context.env.DB);
  const insertStatement = context.env.DB.prepare(
      "INSERT INTO uploads (id, workspace_id, created_by_user_id, r2_key, filename, mime_type, expected_size, actual_size, upload_mode, multipart_upload_id, part_size, status, validation_json, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'uploading', '{\"errors\":[],\"warnings\":[]}', ?, ? WHERE EXISTS (SELECT 1 FROM users INNER JOIN memberships ON memberships.user_id = users.id INNER JOIN workspaces ON workspaces.id = memberships.workspace_id WHERE users.id = ? AND users.status = 'active' AND workspaces.id = ? AND workspaces.status = 'active') AND (SELECT count(*) FROM uploads WHERE workspace_id = ? AND status IN ('created', 'uploading', 'verifying', 'ready')) < ? AND COALESCE((SELECT sum(expected_size) FROM uploads WHERE workspace_id = ? AND status IN ('created', 'uploading', 'verifying', 'ready')), 0) + ? <= ?"
    )
      .bind(
        id,
        auth.workspaceId,
        auth.userId,
        key,
        input.filename,
        input.mimeType,
        input.size,
        mode,
        multipartUploadId,
        partSize,
        now,
        now,
        auth.userId,
        auth.workspaceId,
        auth.workspaceId,
        maxWorkspaceUploads,
        auth.workspaceId,
        input.size,
        maxWorkspaceStorageBytes
      )
      ;
  const inserted = await insertStatement.run().catch(async error => {
    await abortMultipart(context.env, { key, mode, uploadId: multipartUploadId });
    throw error;
  });
  if (inserted.meta.changes !== 1) {
    await abortMultipart(context.env, { key, mode, uploadId: multipartUploadId });
    throw new AppError(
      409,
      "upload_quota_exceeded",
      "The workspace upload limit was reached or the account is no longer active. Remove unused videos and try again."
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
    throw new AppError(409, "upload_not_active", "This upload is not accepting parts.");
  }

  const count = expectedPartCount(row.expectedSize, row.partSize);
  if (input.partNumbers.some(number => number > count)) {
    throw new AppError(422, "invalid_part_number", "A requested part number is out of range.");
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
    throw new AppError(409, "proxy_upload_unavailable", "This proxy part upload is unavailable.");
  }

  const count = expectedPartCount(row.expectedSize, row.partSize);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) {
    throw new AppError(422, "invalid_part_number", "The part number is out of range.");
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
    throw new AppError(400, "missing_part_body", "The upload part body is missing.");
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
    throw new AppError(409, "upload_not_completable", "This upload cannot be completed.");
  }
  const parts = validatePartList(row, input.parts);

  const existing = await context.env.MEDIA.head(row.r2Key);
  if (existing === null) {
    await db
      .update(uploads)
      .set({ status: "verifying", updatedAt: Date.now() })
      .where(eq(uploads.id, row.id));
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
          .where(eq(uploads.id, row.id));
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

  row = await finalizeInspection(db, context.env.MEDIA, row);
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
    return context.body(null, 204);
  }
  const claimed = await context.env.DB.prepare(
    "UPDATE uploads SET status = 'aborted', updated_at = ? WHERE id = ? AND workspace_id = ? AND status <> 'aborted' AND NOT EXISTS (SELECT 1 FROM posts WHERE posts.upload_id = uploads.id)"
  )
    .bind(Date.now(), row.id, auth.workspaceId)
    .run();
  if (claimed.meta.changes !== 1) {
    throw new AppError(409, "upload_in_use", "This video is attached to a post.");
  }

  if (
    row.multipartUploadId !== null &&
    (row.status === "uploading" || row.status === "created")
  ) {
    try {
      await abortMultipart(context.env, {
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
    }
  }
  await deleteStoredObject(db, context.env.MEDIA, row);
  await writeAuditEvent(db, {
    action: "upload.aborted",
    actorUserId: auth.userId,
    entityId: row.id,
    entityType: "upload",
    workspaceId: auth.workspaceId
  });
  return context.body(null, 204);
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
      if (
        row.multipartUploadId !== null &&
        ["created", "uploading", "verifying"].includes(row.status)
      ) {
        await abortMultipart(bindings, {
          key: row.r2Key,
          mode: row.uploadMode,
          uploadId: row.multipartUploadId
        });
      }
      await deleteStoredObject(db, bindings.MEDIA, row);
      if (["created", "uploading", "verifying"].includes(row.status)) {
        await db
          .update(uploads)
          .set({ status: "aborted", updatedAt: Date.now() })
          .where(
            and(
              eq(uploads.id, row.id),
              eq(uploads.status, row.status)
            )
          );
      }
      cleaned += 1;
    } catch (error) {
      safeLog("warn", "upload.cleanup_failed", {
        error: error instanceof Error ? error.message : "unknown",
        uploadId: row.id
      });
    }
  }
  return cleaned;
};
