import { and, eq, ne } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv, Bindings } from "../env";
import { createDb } from "../db/client";
import {
  socialConnections,
  webhookEvents,
  publishDestinations
} from "../db/schema";
import { constantTimeEqual, hmacSha256Hex, sha256Hex } from "../lib/crypto";
import { AppError } from "../lib/errors";
import { readLimitedText } from "../lib/request-body";
import { safeLog } from "../lib/safe-logger";
import {
  encodeCredentials,
  type StoredCredentials
} from "../platforms/credentials";
import { finishDestination } from "../publishing/repository";
import { latestTiktokRemoval } from "../platforms/tiktok-removals";

const maximumWebhookBytes = 1024 * 1024;
const signatureToleranceMs = 5 * 60 * 1000;

const tiktokEventSchema = z.object({
  client_key: z.string().min(1),
  content: z.string(),
  create_time: z.number().int(),
  event: z.string().min(1),
  user_openid: z.string().optional()
});

const tiktokContentSchema = z.object({
  post_id: z.string().optional(),
  publish_id: z.string().optional(),
  reason: z.string().optional()
});

const readRawBody = (request: Request): Promise<string> =>
  readLimitedText(request, maximumWebhookBytes, {
    code: "webhook_too_large",
    message: "The webhook body is too large."
  });

const parseTiktokSignature = (
  value: string | null
): { signature: string; timestamp: string } | null => {
  if (value === null) {
    return null;
  }
  const parts = new Map(
    value.split(",").map(part => {
      const separator = part.indexOf("=");
      return separator === -1
        ? [part.trim(), ""]
        : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
    })
  );
  const timestamp = parts.get("t");
  const signature = parts.get("s");
  return timestamp === undefined || signature === undefined
    ? null
    : { signature, timestamp };
};

const authorizedAtFromMetadata = (value: string): number | null => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const authorizedAt = (parsed as Record<string, unknown>).authorizedAt;
    return typeof authorizedAt === "number" &&
      Number.isSafeInteger(authorizedAt)
      ? authorizedAt
      : null;
  } catch {
    return null;
  }
};

const disconnectTiktokConnection = async (
  bindings: Bindings,
  connection: typeof socialConnections.$inferSelect,
  eventAt: number
): Promise<"disconnected" | "superseded"> => {
  const authorizedAt =
    authorizedAtFromMetadata(connection.metadataJson) ?? connection.createdAt;
  if (eventAt < authorizedAt) {
    return "superseded";
  }

  const revokedCredentials: StoredCredentials = {
    accessToken: "revoked",
    expiresAt: null,
    refreshExpiresAt: null,
    refreshToken: null,
    tokenType: null,
    userAccessToken: null
  };
  const credentialsEncrypted = await encodeCredentials(
    bindings,
    revokedCredentials
  );
  const now = Date.now();
  const results = await bindings.DB.batch([
    bindings.DB.prepare(
      "UPDATE social_connections SET credentials_encrypted = ?, disconnected_at = ?, expires_at = NULL, last_error_code = 'authorization_removed', last_error_message = 'Reconnect TikTok to publish again.', refresh_lease_id = NULL, refresh_lease_expires_at = NULL, status = 'disconnected', updated_at = ? WHERE id = ? AND credentials_encrypted = ? AND status = ?"
    ).bind(
      credentialsEncrypted,
      eventAt,
      now,
      connection.id,
      connection.credentialsEncrypted,
      connection.status
    ),
    bindings.DB.prepare(
      "UPDATE publish_destinations SET status = CASE WHEN status IN ('queued', 'retry_scheduled') AND remote_session_id IS NULL AND remote_post_id IS NULL AND remote_upload_url_encrypted IS NULL AND remote_url IS NULL AND outcome_unknown = 0 AND stage <> 'provider_commit_started' THEN 'cancelled' ELSE 'reconciliation_required' END, stage = CASE WHEN status IN ('queued', 'retry_scheduled') AND remote_session_id IS NULL AND remote_post_id IS NULL AND remote_upload_url_encrypted IS NULL AND remote_url IS NULL AND outcome_unknown = 0 AND stage <> 'provider_commit_started' THEN 'authorization_removed' ELSE 'authorization_removed_outcome_unknown' END, outcome_unknown = CASE WHEN status IN ('queued', 'retry_scheduled') AND remote_session_id IS NULL AND remote_post_id IS NULL AND remote_upload_url_encrypted IS NULL AND remote_url IS NULL AND outcome_unknown = 0 AND stage <> 'provider_commit_started' THEN 0 ELSE 1 END, next_poll_at = NULL, last_error_code = 'authorization_removed', last_error_message = 'TikTok authorization was removed while this destination was pending.', transition_token = ?, updated_at = ? WHERE connection_id = ? AND (status IN ('queued', 'starting', 'transferring', 'processing', 'publishing', 'retry_scheduled') OR (status IN ('awaiting_user_action', 'reauth_required') AND (remote_session_id IS NOT NULL OR remote_post_id IS NOT NULL OR remote_upload_url_encrypted IS NOT NULL OR remote_url IS NOT NULL OR outcome_unknown = 1 OR stage = 'provider_commit_started'))) AND EXISTS (SELECT 1 FROM social_connections WHERE id = ? AND credentials_encrypted = ? AND status = 'disconnected')"
    ).bind(
      crypto.randomUUID(),
      now,
      connection.id,
      connection.id,
      credentialsEncrypted
    ),
    bindings.DB.prepare(
      "UPDATE publish_attempts SET status = (SELECT status FROM publish_destinations WHERE publish_destinations.id = publish_attempts.destination_id), stage = (SELECT stage FROM publish_destinations WHERE publish_destinations.id = publish_attempts.destination_id), error_code = 'authorization_removed', error_message = 'TikTok authorization was removed while this destination was pending.', finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE EXISTS (SELECT 1 FROM publish_destinations WHERE publish_destinations.id = publish_attempts.destination_id AND publish_destinations.connection_id = ? AND publish_destinations.attempt_number = publish_attempts.attempt_number AND publish_destinations.status IN ('cancelled', 'reconciliation_required')) AND EXISTS (SELECT 1 FROM social_connections WHERE id = ? AND credentials_encrypted = ? AND status = 'disconnected')"
    ).bind(now, now, connection.id, connection.id, credentialsEncrypted),
    bindings.DB.prepare(
      "UPDATE posts SET status = CASE WHEN NOT EXISTS (SELECT 1 FROM publish_destinations WHERE post_id = posts.id AND status <> 'published') THEN 'published' WHEN EXISTS (SELECT 1 FROM publish_destinations WHERE post_id = posts.id AND status IN ('queued', 'starting', 'transferring', 'processing', 'publishing', 'retry_scheduled')) THEN 'publishing' WHEN EXISTS (SELECT 1 FROM publish_destinations WHERE post_id = posts.id AND status = 'published') THEN 'partial_success' WHEN NOT EXISTS (SELECT 1 FROM publish_destinations WHERE post_id = posts.id AND status <> 'cancelled') THEN 'cancelled' ELSE 'failed' END, updated_at = ? WHERE id IN (SELECT post_id FROM publish_destinations WHERE connection_id = ?) AND EXISTS (SELECT 1 FROM social_connections WHERE id = ? AND credentials_encrypted = ? AND status = 'disconnected')"
    ).bind(now, connection.id, connection.id, credentialsEncrypted)
  ]);
  return results[0]?.meta.changes === 1 ? "disconnected" : "superseded";
};

export const webhookRoutes = new Hono<AppEnv>();

const verifyMetaChallenge = (context: Context<AppEnv>): Response => {
  const mode = context.req.query("hub.mode");
  const challenge = context.req.query("hub.challenge");
  const token = context.req.query("hub.verify_token");
  const expected = context.env.META_WEBHOOK_VERIFY_TOKEN;
  if (
    mode !== "subscribe" ||
    challenge === undefined ||
    token === undefined ||
    expected === undefined ||
    !constantTimeEqual(token, expected)
  ) {
    throw new AppError(
      403,
      "webhook_verification_failed",
      "Webhook verification failed."
    );
  }
  return context.text(challenge);
};

const recordMetaWebhook = async (
  context: Context<AppEnv>,
  provider: "facebook" | "instagram",
  secret: string | undefined,
  expectedObject: "instagram" | "page"
): Promise<Response> => {
  const raw = await readRawBody(context.req.raw);
  const signatureHeader = context.req.header("X-Hub-Signature-256");
  if (secret === undefined || !signatureHeader?.startsWith("sha256=")) {
    throw new AppError(
      401,
      "invalid_webhook_signature",
      "The webhook signature is invalid."
    );
  }
  const expected = await hmacSha256Hex(secret, raw);
  if (!constantTimeEqual(expected, signatureHeader.slice(7).toLowerCase())) {
    throw new AppError(
      401,
      "invalid_webhook_signature",
      "The webhook signature is invalid."
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new AppError(
      400,
      "invalid_webhook_json",
      "The webhook body is invalid."
    );
  }
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    (body as Record<string, unknown>).object !== expectedObject
  ) {
    throw new AppError(
      400,
      "invalid_webhook_payload",
      "The webhook payload does not match this callback."
    );
  }
  const payloadHash = await sha256Hex(raw);
  await createDb(context.env.DB)
    .insert(webhookEvents)
    .values({
      id: crypto.randomUUID(),
      payloadHash,
      processedAt: Date.now(),
      provider,
      status: "ignored"
    })
    .onConflictDoNothing();
  return context.body(null, 204);
};

webhookRoutes.get("/meta/facebook", verifyMetaChallenge);
webhookRoutes.get("/meta/instagram", verifyMetaChallenge);
webhookRoutes.post("/meta/facebook", context =>
  recordMetaWebhook(context, "facebook", context.env.META_APP_SECRET, "page")
);
webhookRoutes.post("/meta/instagram", context =>
  recordMetaWebhook(
    context,
    "instagram",
    context.env.INSTAGRAM_APP_SECRET,
    "instagram"
  )
);

webhookRoutes.post("/tiktok", async context => {
  const raw = await readRawBody(context.req.raw);
  const signature = parseTiktokSignature(
    context.req.header("TikTok-Signature") ?? null
  );
  const secret = context.env.TIKTOK_CLIENT_SECRET;
  const timestampSeconds = Number(signature?.timestamp);
  if (
    signature === null ||
    secret === undefined ||
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Date.now() - timestampSeconds * 1000) > signatureToleranceMs
  ) {
    throw new AppError(
      401,
      "invalid_webhook_signature",
      "The webhook signature is invalid."
    );
  }
  const expected = await hmacSha256Hex(secret, signature.timestamp + "." + raw);
  if (!constantTimeEqual(expected, signature.signature.toLowerCase())) {
    throw new AppError(
      401,
      "invalid_webhook_signature",
      "The webhook signature is invalid."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(
      400,
      "invalid_webhook_json",
      "The webhook body is invalid."
    );
  }
  const event = tiktokEventSchema.safeParse(parsed);
  if (
    !event.success ||
    context.env.TIKTOK_CLIENT_KEY === undefined ||
    !constantTimeEqual(event.data.client_key, context.env.TIKTOK_CLIENT_KEY)
  ) {
    throw new AppError(
      400,
      "invalid_webhook_payload",
      "The webhook payload is invalid."
    );
  }

  const payloadHash = await sha256Hex(raw);
  let id: string = crypto.randomUUID();
  const inserted = await createDb(context.env.DB)
    .insert(webhookEvents)
    .values({
      id,
      payloadHash,
      provider: "tiktok",
      providerEventId:
        event.data.event === "authorization.removed" &&
        event.data.user_openid !== undefined
          ? [
              event.data.event,
              event.data.user_openid,
              String(event.data.create_time)
            ].join(":")
          : event.data.event,
      status: "received"
    })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  if (inserted.length === 0) {
    const [existing] = await createDb(context.env.DB)
      .select()
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.provider, "tiktok"),
          eq(webhookEvents.payloadHash, payloadHash)
        )
      )
      .limit(1);
    if (existing === undefined) {
      return context.body(null, 200);
    }
    id = existing.id;
    const reclaimed = await context.env.DB.prepare(
      "UPDATE webhook_events SET error_message = NULL, processed_at = NULL, status = 'received' WHERE id = ? AND (status = 'failed' OR (status = 'received' AND created_at < ?))"
    )
      .bind(id, Date.now() - 60 * 1000)
      .run();
    if (reclaimed.meta.changes !== 1) {
      if (existing.status === "processed" || existing.status === "ignored") {
        return context.body(null, 200);
      }
      throw new AppError(
        503,
        "webhook_processing_in_progress",
        "Webhook processing is still in progress."
      );
    }
  }

  try {
    if (event.data.event === "authorization.removed") {
      if (event.data.user_openid !== undefined) {
        const connections = await createDb(context.env.DB)
          .select()
          .from(socialConnections)
          .where(
            and(
              eq(socialConnections.provider, "tiktok"),
              eq(socialConnections.remoteAccountId, event.data.user_openid)
            )
          );
        const eventAt = event.data.create_time * 1000;
        for (const connection of connections) {
          if (connection.status !== "disconnected") {
            const result = await disconnectTiktokConnection(
              context.env,
              connection,
              eventAt
            );
            if (result === "superseded") {
              const [latest] = await createDb(context.env.DB)
                .select()
                .from(socialConnections)
                .where(eq(socialConnections.id, connection.id))
                .limit(1);
              if (
                latest !== undefined &&
                latest.status !== "disconnected" &&
                eventAt >=
                  (authorizedAtFromMetadata(latest.metadataJson) ??
                    latest.createdAt)
              ) {
                throw new Error(
                  "TikTok authorization removal raced a connection update."
                );
              }
            }
          }
        }
      }
    } else if (event.data.event.startsWith("post.publish.")) {
      let content: unknown;
      try {
        content = JSON.parse(event.data.content);
      } catch {
        content = null;
      }
      const details = tiktokContentSchema.safeParse(content);
      const publishId = details.success ? details.data.publish_id : undefined;
      if (publishId !== undefined) {
        const [destination] = await createDb(context.env.DB)
          .select()
          .from(publishDestinations)
          .where(
            and(
              eq(publishDestinations.platform, "tiktok"),
              eq(publishDestinations.remoteSessionId, publishId)
            )
          )
          .limit(1);
        if (destination !== undefined) {
          if (
            event.data.event === "post.publish.failed" &&
            destination.status !== "published"
          ) {
            await finishDestination(context.env, {
              attemptNumber: destination.attemptNumber,
              destinationId: destination.id,
              errorCode: details.success
                ? (details.data.reason ?? "tiktok_publish_failed")
                : "tiktok_publish_failed",
              errorMessage:
                "TikTok reported that the post could not be published.",
              authoritative: true,
              stage: "tiktok_webhook_failed",
              status: "failed_permanent"
            });
          } else if (
            event.data.event === "post.publish.complete" &&
            destination.status !== "published"
          ) {
            await finishDestination(context.env, {
              attemptNumber: destination.attemptNumber,
              destinationId: destination.id,
              stage: "tiktok_webhook_complete",
              status: "published"
            });
          } else if (
            event.data.event === "post.publish.publicly_available" &&
            details.success &&
            details.data.post_id !== undefined
          ) {
            await finishDestination(context.env, {
              attemptNumber: destination.attemptNumber,
              destinationId: destination.id,
              providerPostId: details.data.post_id,
              stage: "tiktok_publicly_available",
              status: "published"
            });
          }
        }
      }
    }

    if (
      event.data.event === "authorization.removed" &&
      event.data.user_openid !== undefined
    ) {
      const latestRemoval = await latestTiktokRemoval(
        context.env,
        event.data.user_openid
      );
      const remaining = await createDb(context.env.DB)
        .select()
        .from(socialConnections)
        .where(
          and(
            eq(socialConnections.provider, "tiktok"),
            eq(socialConnections.remoteAccountId, event.data.user_openid),
            ne(socialConnections.status, "disconnected")
          )
        );
      if (
        latestRemoval !== null &&
        remaining.some(
          connection =>
            latestRemoval >=
            (authorizedAtFromMetadata(connection.metadataJson) ??
              connection.createdAt)
        )
      ) {
        throw new Error(
          "TikTok authorization removal raced a connection update."
        );
      }
    }
    await createDb(context.env.DB)
      .update(webhookEvents)
      .set({ processedAt: Date.now(), status: "processed" })
      .where(eq(webhookEvents.id, id));
    return context.body(null, 200);
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : "unknown";
    await createDb(context.env.DB)
      .update(webhookEvents)
      .set({ errorMessage: message, processedAt: Date.now(), status: "failed" })
      .where(eq(webhookEvents.id, id));
    safeLog("error", "webhook.tiktok_processing_failed", {
      error: message,
      webhookEventId: id
    });
    throw error;
  }
});
