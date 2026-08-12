import { and, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";

import type { AppEnv } from "../env";
import { createDb } from "../db/client";
import { mediaLeases, uploads } from "../db/schema";
import { AppError } from "../lib/errors";
import { createMediaLease, verifyMediaLeaseSignature } from "../lib/media-leases";
import { requireAuth } from "../middleware/auth";

const parseRange = (
  header: string,
  size: number
): { end: number; length: number; start: number } | null => {
  if (header.includes(",")) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) {
    return null;
  }
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText.length === 0 && endText.length === 0) {
    return null;
  }

  let start: number;
  let end: number;
  if (startText.length === 0) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText.length === 0 ? size - 1 : Number(endText);
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null;
  }
  end = Math.min(end, size - 1);
  return { end, length: end - start + 1, start };
};

export const mediaRoutes = new Hono<AppEnv>();

mediaRoutes.on(["GET", "HEAD"], "/provider/:token/video.mp4", async context => {
  const token = context.req.param("token");
  const separator = token.lastIndexOf(".");
  if (separator < 1) {
    throw new AppError(404, "media_not_found", "The media lease was not found.");
  }
  const id = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!(await verifyMediaLeaseSignature(context.env, id, signature))) {
    throw new AppError(404, "media_not_found", "The media lease was not found.");
  }

  const [row] = await createDb(context.env.DB)
    .select({
      expiresAt: mediaLeases.expiresAt,
      mimeType: uploads.mimeType,
      r2Key: uploads.r2Key,
      status: uploads.status
    })
    .from(mediaLeases)
    .innerJoin(uploads, eq(uploads.id, mediaLeases.uploadId))
    .where(
      and(
        eq(mediaLeases.id, id),
        gt(mediaLeases.expiresAt, Date.now()),
        isNull(mediaLeases.revokedAt)
      )
    )
    .limit(1);
  if (row?.status !== "ready") {
    throw new AppError(404, "media_not_found", "The media lease was not found.");
  }

  const metadata = await context.env.MEDIA.head(row.r2Key);
  if (metadata === null) {
    throw new AppError(404, "media_not_found", "The media object was not found.");
  }
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Type": row.mimeType,
    ETag: metadata.httpEtag
  });
  const rangeHeader = context.req.header("Range");
  if (rangeHeader === undefined) {
    headers.set("Content-Length", String(metadata.size));
    if (context.req.method === "HEAD") {
      return new Response(null, { headers, status: 200 });
    }
    const object = await context.env.MEDIA.get(row.r2Key);
    if (object === null) {
      throw new AppError(404, "media_not_found", "The media object was not found.");
    }
    return new Response(object.body, { headers, status: 200 });
  }

  const range = parseRange(rangeHeader, metadata.size);
  if (range === null) {
    headers.set("Content-Range", "bytes */" + String(metadata.size));
    return new Response(null, { headers, status: 416 });
  }
  headers.set(
    "Content-Range",
    "bytes " + String(range.start) + "-" + String(range.end) + "/" + String(metadata.size)
  );
  headers.set("Content-Length", String(range.length));
  if (context.req.method === "HEAD") {
    return new Response(null, { headers, status: 206 });
  }
  const object = await context.env.MEDIA.get(row.r2Key, {
    range: { length: range.length, offset: range.start }
  });
  if (object === null) {
    throw new AppError(404, "media_not_found", "The media object was not found.");
  }
  return new Response(object.body, { headers, status: 206 });
});

export const previewRoutes = new Hono<AppEnv>();
previewRoutes.use("*", requireAuth);

previewRoutes.post("/:id/preview-lease", async context => {
  const auth = context.get("auth");
  const db = createDb(context.env.DB);
  const [upload] = await db
    .select()
    .from(uploads)
    .where(
      and(
        eq(uploads.id, context.req.param("id")),
        eq(uploads.workspaceId, auth.workspaceId),
        eq(uploads.status, "ready")
      )
    )
    .limit(1);
  if (upload === undefined) {
    throw new AppError(404, "upload_not_found", "A ready upload was not found.");
  }

  return context.json({
    lease: await createMediaLease(db, context.env, {
      destinationId: null,
      purpose: "preview",
      ttlMs: 60 * 60 * 1000,
      uploadId: upload.id
    })
  });
});
