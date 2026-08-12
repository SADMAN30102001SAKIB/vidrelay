import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../env";
import { createDb } from "../db/client";
import {
  socialConnections,
  webhookEvents,
  publishDestinations
} from "../db/schema";
import {
  constantTimeEqual,
  hmacSha256Hex,
  sha256Hex
} from "../lib/crypto";
import { AppError } from "../lib/errors";
import { readLimitedText } from "../lib/request-body";
import { safeLog } from "../lib/safe-logger";
import { encodeCredentials, type StoredCredentials } from "../platforms/credentials";
import { finishDestination, updateDestination } from "../publishing/repository";

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
  fail_reason: z.string().optional(),
  post_id: z.string().optional(),
  publish_id: z.string().optional()
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

export const webhookRoutes = new Hono<AppEnv>();

webhookRoutes.get("/meta", context => {
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
    throw new AppError(403, "webhook_verification_failed", "Webhook verification failed.");
  }
  return context.text(challenge);
});

webhookRoutes.post("/meta", async context => {
  const raw = await readRawBody(context.req.raw);
  const signatureHeader = context.req.header("X-Hub-Signature-256");
  const secret = context.env.META_APP_SECRET;
  if (
    secret === undefined ||
    !signatureHeader?.startsWith("sha256=")
  ) {
    throw new AppError(401, "invalid_webhook_signature", "The webhook signature is invalid.");
  }
  const expected = await hmacSha256Hex(secret, raw);
  if (!constantTimeEqual(expected, signatureHeader.slice(7).toLowerCase())) {
    throw new AppError(401, "invalid_webhook_signature", "The webhook signature is invalid.");
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new AppError(400, "invalid_webhook_json", "The webhook body is invalid.");
  }
  const provider =
    body !== null &&
    typeof body === "object" &&
    (body as Record<string, unknown>).object === "instagram"
      ? "instagram"
      : "facebook";
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
});

webhookRoutes.post("/tiktok", async context => {
  const raw = await readRawBody(context.req.raw);
  const signature = parseTiktokSignature(context.req.header("TikTok-Signature") ?? null);
  const secret = context.env.TIKTOK_CLIENT_SECRET;
  const timestampSeconds = Number(signature?.timestamp);
  if (
    signature === null ||
    secret === undefined ||
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Date.now() - timestampSeconds * 1000) > signatureToleranceMs
  ) {
    throw new AppError(401, "invalid_webhook_signature", "The webhook signature is invalid.");
  }
  const expected = await hmacSha256Hex(secret, signature.timestamp + "." + raw);
  if (!constantTimeEqual(expected, signature.signature.toLowerCase())) {
    throw new AppError(401, "invalid_webhook_signature", "The webhook signature is invalid.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(400, "invalid_webhook_json", "The webhook body is invalid.");
  }
  const event = tiktokEventSchema.safeParse(parsed);
  if (
    !event.success ||
    context.env.TIKTOK_CLIENT_KEY === undefined ||
    !constantTimeEqual(event.data.client_key, context.env.TIKTOK_CLIENT_KEY)
  ) {
    throw new AppError(400, "invalid_webhook_payload", "The webhook payload is invalid.");
  }

  const payloadHash = await sha256Hex(raw);
  let id: string = crypto.randomUUID();
  const inserted = await createDb(context.env.DB)
    .insert(webhookEvents)
    .values({
      id,
      payloadHash,
      provider: "tiktok",
      providerEventId: event.data.event,
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
    if (existing?.status !== "failed") {
      return context.body(null, 204);
    }
    id = existing.id;
    await createDb(context.env.DB)
      .update(webhookEvents)
      .set({ errorMessage: null, processedAt: null, status: "received" })
      .where(eq(webhookEvents.id, id));
  }

  try {
    if (event.data.event === "authorization.removed") {
      if (event.data.user_openid !== undefined) {
        const revokedCredentials: StoredCredentials = {
          accessToken: "revoked",
          expiresAt: null,
          refreshExpiresAt: null,
          refreshToken: null,
          tokenType: null,
          userAccessToken: null
        };
        await createDb(context.env.DB)
          .update(socialConnections)
          .set({
            credentialsEncrypted: await encodeCredentials(
              context.env,
              revokedCredentials
            ),
            disconnectedAt: Date.now(),
            expiresAt: null,
            lastErrorCode: "authorization_removed",
            lastErrorMessage: "Reconnect TikTok to publish again.",
            status: "disconnected",
            updatedAt: Date.now()
          })
          .where(
            and(
              eq(socialConnections.provider, "tiktok"),
              eq(socialConnections.remoteAccountId, event.data.user_openid)
            )
          );
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
                ? (details.data.fail_reason ?? "tiktok_publish_failed")
                : "tiktok_publish_failed",
              errorMessage: "TikTok reported that the post could not be published.",
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
            await updateDestination(
              context.env,
              destination.id,
              destination.attemptNumber,
              {
                remotePostId: details.data.post_id,
                stage: "tiktok_publicly_available",
                status: "published"
              }
            );
          }
        }
      }
    }

    await createDb(context.env.DB)
      .update(webhookEvents)
      .set({ processedAt: Date.now(), status: "processed" })
      .where(eq(webhookEvents.id, id));
    return context.body(null, 204);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "unknown";
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
