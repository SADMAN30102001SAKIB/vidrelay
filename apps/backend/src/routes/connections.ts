import { platformSchema } from "@vidrelay/shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../env";
import { createDb } from "../db/client";
import { oauthStates, sessions, socialConnections } from "../db/schema";
import { writeAuditEvent } from "../lib/audit";
import { getCapability } from "../lib/capabilities";
import { readCookie, sessionCookieName } from "../lib/cookies";
import {
  decryptJson,
  encryptJson,
  randomToken,
  sha256Base64Url
} from "../lib/crypto";
import { AppError, ProviderError } from "../lib/errors";
import { safeLog } from "../lib/safe-logger";
import {
  createAuthorizationRequest,
  exchangeAndDiscover
} from "../oauth/providers";
import {
  decodeCredentials,
  encodeCredentials,
  ensureFreshCredentials,
  toConnection,
  type StoredCredentials
} from "../platforms/credentials";
import {
  activeGrantSiblingState,
  type ActiveGrantSiblingState
} from "../platforms/grants";
import { providerJson } from "../platforms/http";
import {
  facebookScopes,
  fetchMetaGrantedScopes,
  hasEveryScope,
  instagramScopes
} from "../platforms/meta-permissions";
import { revokeProviderCredentials } from "../platforms/revoke";
import { requireAuth } from "../middleware/auth";

const safeReturnTo = (value: string | undefined): string => {
  if (
    value === undefined ||
    !(value === "/app" || value.startsWith("/app/")) ||
    value.includes("\\") ||
    value.startsWith("//")
  ) {
    return "/app/connections";
  }

  return value.slice(0, 500);
};

const callbackRedirect = (
  appOrigin: string,
  returnTo: string,
  provider: string,
  result: string,
  count?: number
): string => {
  const url = new URL(returnTo, appOrigin);
  url.searchParams.set("provider", provider);
  url.searchParams.set("result", result);
  if (count !== undefined) {
    url.searchParams.set("count", String(count));
  }
  return url.toString();
};

const facebookPublishingTasks = new Set([
  "CREATE_CONTENT",
  "MANAGE",
  "PROFILE_PLUS_CREATE_CONTENT",
  "PROFILE_PLUS_FULL_CONTROL",
  "PROFILE_PLUS_MANAGE"
]);

const metadataObject = (value: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

export const connectionRoutes = new Hono<AppEnv>();
export const oauthRoutes = new Hono<AppEnv>();

connectionRoutes.get("/", requireAuth, async context => {
  const auth = context.get("auth");
  const rows = await createDb(context.env.DB)
    .select()
    .from(socialConnections)
    .where(eq(socialConnections.workspaceId, auth.workspaceId));
  return context.json({ connections: rows.map(toConnection) });
});

oauthRoutes.get("/:provider/start", requireAuth, async context => {
  const providerResult = platformSchema.safeParse(
    context.req.param("provider")
  );
  if (!providerResult.success) {
    throw new AppError(
      404,
      "provider_not_found",
      "This provider is not supported."
    );
  }

  const provider = providerResult.data;
  const capability = getCapability(context.env, provider);
  if (!capability.configured || capability.mode === "disabled") {
    throw new AppError(
      409,
      "provider_not_configured",
      "This provider has not been configured by the operator."
    );
  }

  const auth = context.get("auth");
  const state = randomToken();
  const request = await createAuthorizationRequest(
    context.env,
    provider,
    state
  );
  const encryptionKey = context.env.TOKEN_ENCRYPTION_KEY;
  if (encryptionKey === undefined || encryptionKey.length === 0) {
    throw new AppError(
      503,
      "encryption_not_configured",
      "Credential encryption has not been configured."
    );
  }

  const now = Date.now();
  await createDb(context.env.DB)
    .insert(oauthStates)
    .values({
      codeVerifierEncrypted:
        request.codeVerifier === null
          ? null
          : await encryptJson({ value: request.codeVerifier }, encryptionKey),
      createdAt: now,
      expiresAt: now + 10 * 60 * 1000,
      id: await sha256Base64Url(state),
      provider,
      returnTo: safeReturnTo(context.req.query("returnTo")),
      sessionId: auth.sessionHash,
      userId: auth.userId,
      workspaceId: auth.workspaceId
    });

  return context.redirect(request.url, 302);
});

oauthRoutes.get("/:provider/callback", async context => {
  const providerResult = platformSchema.safeParse(
    context.req.param("provider")
  );
  const provider = providerResult.success ? providerResult.data : null;
  const state = context.req.query("state");
  const fallback = callbackRedirect(
    context.env.PUBLIC_APP_ORIGIN,
    "/app/connections",
    provider ?? "unknown",
    "invalid_state"
  );
  if (provider === null || state === undefined || state.length < 20) {
    return context.redirect(fallback, 303);
  }

  const sessionToken = readCookie(context.req.raw, sessionCookieName);
  if (sessionToken === null || sessionToken.length < 32) {
    return context.redirect(fallback, 303);
  }

  const stateHash = await sha256Base64Url(state);
  const sessionHash = await sha256Base64Url(sessionToken);
  const db = createDb(context.env.DB);
  const [stored] = await db
    .select({
      codeVerifierEncrypted: oauthStates.codeVerifierEncrypted,
      expiresAt: oauthStates.expiresAt,
      returnTo: oauthStates.returnTo,
      userId: oauthStates.userId,
      workspaceId: oauthStates.workspaceId
    })
    .from(oauthStates)
    .innerJoin(sessions, eq(sessions.id, oauthStates.sessionId))
    .where(
      and(
        eq(oauthStates.id, stateHash),
        eq(oauthStates.provider, provider),
        eq(oauthStates.sessionId, sessionHash),
        gt(sessions.expiresAt, Date.now()),
        isNull(oauthStates.consumedAt)
      )
    )
    .limit(1);
  if (stored === undefined || stored.expiresAt <= Date.now()) {
    return context.redirect(fallback, 303);
  }
  const oauthState = stored;

  const consumed = await context.env.DB.prepare(
    "UPDATE oauth_states SET consumed_at = ? WHERE id = ? AND session_id = ? AND consumed_at IS NULL AND expires_at > ?"
  )
    .bind(Date.now(), stateHash, sessionHash, Date.now())
    .run();
  if (consumed.meta.changes !== 1) {
    return context.redirect(fallback, 303);
  }

  const denied = context.req.query("error");
  if (denied !== undefined) {
    return context.redirect(
      callbackRedirect(
        context.env.PUBLIC_APP_ORIGIN,
        oauthState.returnTo,
        provider,
        "denied"
      ),
      303
    );
  }

  const code = context.req.query("code");
  if (code === undefined || code.length === 0) {
    return context.redirect(
      callbackRedirect(
        context.env.PUBLIC_APP_ORIGIN,
        oauthState.returnTo,
        provider,
        "failed"
      ),
      303
    );
  }

  try {
    let codeVerifier: string | null = null;
    if (oauthState.codeVerifierEncrypted !== null) {
      const key = context.env.TOKEN_ENCRYPTION_KEY;
      if (key === undefined || key.length === 0) {
        throw new Error("TOKEN_ENCRYPTION_KEY is not configured.");
      }
      const decoded = await decryptJson<{ value: string }>(
        oauthState.codeVerifierEncrypted,
        key
      );
      codeVerifier = decoded.value;
    }

    const count = await exchangeAndDiscover(provider, {
      bindings: context.env,
      code,
      codeVerifier,
      db,
      userId: oauthState.userId,
      workspaceId: oauthState.workspaceId
    });
    if (count === 0) {
      return context.redirect(
        callbackRedirect(
          context.env.PUBLIC_APP_ORIGIN,
          oauthState.returnTo,
          provider,
          "no_eligible_accounts"
        ),
        303
      );
    }

    try {
      await writeAuditEvent(db, {
        action: "connection.oauth_completed",
        actorUserId: oauthState.userId,
        entityType: "connection",
        metadata: { count, provider },
        workspaceId: oauthState.workspaceId
      });
    } catch (error) {
      safeLog("error", "oauth.audit_failed", {
        error: error instanceof Error ? error.message : "unknown",
        provider,
        requestId: context.get("requestId")
      });
    }
    return context.redirect(
      callbackRedirect(
        context.env.PUBLIC_APP_ORIGIN,
        oauthState.returnTo,
        provider,
        "connected",
        count
      ),
      303
    );
  } catch (error) {
    safeLog("error", "oauth.callback_failed", {
      error: error instanceof Error ? error.message : "unknown",
      provider,
      requestId: context.get("requestId")
    });
    return context.redirect(
      callbackRedirect(
        context.env.PUBLIC_APP_ORIGIN,
        oauthState.returnTo,
        provider,
        "failed"
      ),
      303
    );
  }
});

connectionRoutes.post(
  "/:id/tiktok/creator-info",
  requireAuth,
  async context => {
    const auth = context.get("auth");
    const db = createDb(context.env.DB);
    const [row] = await db
      .select()
      .from(socialConnections)
      .where(
        and(
          eq(socialConnections.id, context.req.param("id")),
          eq(socialConnections.workspaceId, auth.workspaceId),
          eq(socialConnections.provider, "tiktok")
        )
      )
      .limit(1);
    if (
      row === undefined ||
      row.status === "disconnected" ||
      row.lastErrorCode?.startsWith("disconnecting:") ||
      row.lastErrorCode?.startsWith("account_deletion_revoke_started") ||
      row.lastErrorCode === "account_deletion_revoke_completed"
    ) {
      throw new AppError(
        404,
        "connection_not_found",
        "The TikTok connection was not found."
      );
    }

    const fresh = await ensureFreshCredentials(db, context.env, row);
    const credentials = fresh.credentials;
    const response = z
      .object({
        data: z.object({
          comment_disabled: z.boolean(),
          creator_avatar_url: z.string().url().optional(),
          creator_nickname: z.string(),
          duet_disabled: z.boolean(),
          max_video_post_duration_sec: z.number().int().positive(),
          privacy_level_options: z.array(
            z.enum([
              "PUBLIC_TO_EVERYONE",
              "MUTUAL_FOLLOW_FRIENDS",
              "FOLLOWER_OF_CREATOR",
              "SELF_ONLY"
            ])
          ),
          stitch_disabled: z.boolean()
        }),
        error: z.object({ code: z.string(), message: z.string().optional() })
      })
      .parse(
        await providerJson<unknown>(
          "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
          {
            body: "{}",
            headers: {
              Authorization: "Bearer " + credentials.accessToken,
              "Content-Type": "application/json; charset=UTF-8"
            },
            method: "POST"
          },
          { operation: "tiktok_creator_info" }
        )
      );
    if (response.error.code !== "ok") {
      throw new AppError(
        502,
        "provider_rejected",
        "TikTok did not return creator information."
      );
    }

    const now = Date.now();
    const metadata = metadataObject(row.metadataJson);
    const updatedCreatorInfo = await db
      .update(socialConnections)
      .set({
        lastCheckedAt: now,
        metadataJson: JSON.stringify({
          ...metadata,
          creatorInfo: response.data,
          creatorInfoFetchedAt: now
        }),
        updatedAt: now
      })
      .where(
        and(
          eq(socialConnections.id, row.id),
          eq(socialConnections.status, row.status),
          eq(
            socialConnections.credentialsEncrypted,
            fresh.credentialsEncrypted
          ),
          fresh.lastErrorCode === null
            ? isNull(socialConnections.lastErrorCode)
            : eq(socialConnections.lastErrorCode, fresh.lastErrorCode)
        )
      )
      .returning({ id: socialConnections.id });
    if (updatedCreatorInfo.length === 0) {
      throw new AppError(
        409,
        "connection_changed",
        "The TikTok connection changed while creator information was loading."
      );
    }

    return context.json({ creatorInfo: response.data });
  }
);

connectionRoutes.post("/:id/check", requireAuth, async context => {
  const auth = context.get("auth");
  const db = createDb(context.env.DB);
  const [row] = await db
    .select()
    .from(socialConnections)
    .where(
      and(
        eq(socialConnections.id, context.req.param("id")),
        eq(socialConnections.workspaceId, auth.workspaceId)
      )
    )
    .limit(1);
  if (
    row === undefined ||
    row.status === "disconnected" ||
    row.lastErrorCode?.startsWith("disconnecting:") ||
    row.lastErrorCode?.startsWith("account_deletion_revoke_started") ||
    row.lastErrorCode === "account_deletion_revoke_completed"
  ) {
    throw new AppError(
      404,
      "connection_not_found",
      "The connection was not found."
    );
  }

  let checkedCredentialsEncrypted = row.credentialsEncrypted;
  const checkedConnectionStatus = row.status;
  let checkedLastErrorCode = row.lastErrorCode;
  try {
    const fresh = await ensureFreshCredentials(db, context.env, row);
    const credentials = fresh.credentials;
    checkedCredentialsEncrypted = fresh.credentialsEncrypted;
    checkedLastErrorCode = fresh.lastErrorCode;
    if (row.provider === "youtube") {
      const url = new URL("https://www.googleapis.com/youtube/v3/channels");
      url.searchParams.set("mine", "true");
      url.searchParams.set("part", "id");
      await providerJson<unknown>(
        url.toString(),
        { headers: { Authorization: "Bearer " + credentials.accessToken } },
        { operation: "youtube_connection_check" }
      );
    } else if (row.provider === "tiktok") {
      const url = new URL("https://open.tiktokapis.com/v2/user/info/");
      url.searchParams.set("fields", "open_id,display_name");
      await providerJson<unknown>(
        url.toString(),
        { headers: { Authorization: "Bearer " + credentials.accessToken } },
        { operation: "tiktok_connection_check" }
      );
    } else if (row.provider === "facebook") {
      if (credentials.userAccessToken === null) {
        throw new ProviderError({
          code: "reauth_required",
          message: "Reconnect this Facebook account."
        });
      }
      const url = new URL(
        "https://graph.facebook.com/" +
          context.env.META_GRAPH_VERSION +
          "/me/accounts"
      );
      url.searchParams.set("fields", "id,tasks");
      url.searchParams.set("limit", "100");
      const response = z
        .object({
          data: z.array(
            z.object({
              id: z.union([z.string(), z.number()]).transform(String),
              tasks: z.array(z.string()).optional()
            })
          )
        })
        .parse(
          await providerJson<unknown>(
            url.toString(),
            {
              headers: {
                Authorization: "Bearer " + credentials.userAccessToken
              }
            },
            { operation: "facebook_connection_check" }
          )
        );
      const page = response.data.find(
        candidate => candidate.id === row.remoteAccountId
      );
      if (
        page === undefined ||
        !(page.tasks ?? []).some(task => facebookPublishingTasks.has(task))
      ) {
        throw new ProviderError({
          code: "facebook_publish_permission_missing",
          message: "Facebook no longer grants publishing access to this Page."
        });
      }
      const grantedScopes = await fetchMetaGrantedScopes(
        context.env,
        "facebook",
        credentials.userAccessToken
      );
      if (!hasEveryScope(grantedScopes, facebookScopes)) {
        throw new ProviderError({
          code: "facebook_publish_permission_missing",
          message: "Facebook no longer grants every required permission."
        });
      }
    } else {
      const host = "graph.instagram.com";
      const url = new URL(
        "https://" +
          host +
          "/" +
          context.env.META_GRAPH_VERSION +
          "/" +
          encodeURIComponent(row.remoteAccountId)
      );
      url.searchParams.set("fields", "id,username");
      await providerJson<unknown>(
        url.toString(),
        { headers: { Authorization: "Bearer " + credentials.accessToken } },
        { operation: "instagram_connection_check" }
      );
      const grantedScopes = await fetchMetaGrantedScopes(
        context.env,
        "instagram",
        credentials.accessToken
      );
      if (!hasEveryScope(grantedScopes, instagramScopes)) {
        throw new ProviderError({
          code: "instagram_publish_permission_missing",
          message: "Instagram no longer grants every required permission."
        });
      }
    }

    const now = Date.now();
    const checkedConnection = await db
      .update(socialConnections)
      .set({
        lastCheckedAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
        status: "connected",
        updatedAt: now
      })
      .where(
        and(
          eq(socialConnections.id, row.id),
          eq(socialConnections.status, checkedConnectionStatus),
          eq(
            socialConnections.credentialsEncrypted,
            checkedCredentialsEncrypted
          ),
          checkedLastErrorCode === null
            ? isNull(socialConnections.lastErrorCode)
            : eq(socialConnections.lastErrorCode, checkedLastErrorCode)
        )
      )
      .returning({ id: socialConnections.id });
    if (checkedConnection.length === 0) {
      throw new AppError(
        409,
        "connection_changed",
        "The connection changed while it was being checked."
      );
    }
    const [updated] = await db
      .select()
      .from(socialConnections)
      .where(eq(socialConnections.id, row.id))
      .limit(1);
    if (updated === undefined) {
      throw new AppError(
        404,
        "connection_not_found",
        "The connection was not found."
      );
    }
    return context.json({ connection: toConnection(updated) });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    const requiresReauth =
      error instanceof ProviderError &&
      (error.code === "reauth_required" ||
        error.providerStatus === 401 ||
        error.providerStatus === 403);
    const publishPermissionMissing =
      error instanceof ProviderError &&
      (error.code === "facebook_publish_permission_missing" ||
        error.code === "instagram_publish_permission_missing");
    const missingPermissionMessage =
      row.provider === "instagram"
        ? "Instagram no longer grants every required publishing permission."
        : "Facebook no longer grants publishing access to this Page.";
    await db
      .update(socialConnections)
      .set({
        lastCheckedAt: Date.now(),
        lastErrorCode: requiresReauth
          ? "authorization_invalid"
          : publishPermissionMissing
            ? "publish_permission_missing"
            : "connection_check_failed",
        lastErrorMessage: requiresReauth
          ? "Reconnect this account to continue publishing."
          : publishPermissionMissing
            ? missingPermissionMessage
            : "The provider connection could not be checked.",
        status: requiresReauth
          ? "reauth_required"
          : publishPermissionMissing
            ? "limited"
            : checkedConnectionStatus,
        updatedAt: Date.now()
      })
      .where(
        and(
          eq(socialConnections.id, row.id),
          eq(socialConnections.status, checkedConnectionStatus),
          eq(
            socialConnections.credentialsEncrypted,
            checkedCredentialsEncrypted
          ),
          checkedLastErrorCode === null
            ? isNull(socialConnections.lastErrorCode)
            : eq(socialConnections.lastErrorCode, checkedLastErrorCode)
        )
      );
    throw new AppError(
      requiresReauth || publishPermissionMissing ? 409 : 502,
      requiresReauth
        ? "reauth_required"
        : publishPermissionMissing
          ? "publish_permission_missing"
          : "connection_check_failed",
      requiresReauth
        ? "Reconnect this account to continue publishing."
        : publishPermissionMissing
          ? missingPermissionMessage
          : "The provider connection could not be checked."
    );
  }
});

connectionRoutes.delete("/:id", requireAuth, async context => {
  const auth = context.get("auth");
  const localOnlyValue = context.req.query("localOnly");
  if (localOnlyValue !== undefined && localOnlyValue !== "true") {
    throw new AppError(
      400,
      "invalid_local_only_resolution",
      "The local-only disconnect resolution is invalid."
    );
  }
  const localOnly = localOnlyValue === "true";
  const db = createDb(context.env.DB);
  const [row] = await db
    .select()
    .from(socialConnections)
    .where(
      and(
        eq(socialConnections.id, context.req.param("id")),
        eq(socialConnections.workspaceId, auth.workspaceId)
      )
    )
    .limit(1);
  if (row === undefined) {
    throw new AppError(
      404,
      "connection_not_found",
      "The connection was not found."
    );
  }
  if (row.status === "disconnected") {
    return context.body(null, 204);
  }

  const credentials = localOnly
    ? null
    : await decodeCredentials(context.env, row.credentialsEncrypted);
  const now = Date.now();
  const staleDisconnectBefore = now - 15 * 60 * 1000;
  const disconnectToken = "disconnecting:" + crypto.randomUUID();
  const claim = await context.env.DB.batch([
    context.env.DB.prepare(
      "UPDATE social_connections SET status = 'limited', last_error_code = ?, last_error_message = 'Provider authorization is being revoked.', refresh_lease_id = NULL, refresh_lease_expires_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ? AND credentials_encrypted = ? AND ((status = ? AND (last_error_code IS NULL OR (last_error_code NOT LIKE 'disconnecting:%' AND last_error_code NOT LIKE 'account_deletion_revoke_started%' AND last_error_code <> 'account_deletion_revoke_completed'))) OR (? = 1 AND status = 'limited' AND last_error_code LIKE 'disconnecting:%') OR (status = 'limited' AND last_error_code LIKE 'disconnecting:%' AND updated_at < ?)) AND (refresh_lease_id IS NULL OR (refresh_lease_expires_at IS NOT NULL AND refresh_lease_expires_at < ?)) AND EXISTS (SELECT 1 FROM workspaces INNER JOIN users ON users.id = social_connections.connected_by_user_id WHERE workspaces.id = social_connections.workspace_id AND workspaces.status = 'active' AND users.status = 'active') AND (? = 1 OR NOT EXISTS (SELECT 1 FROM social_connections AS sibling WHERE sibling.provider = social_connections.provider AND sibling.id <> social_connections.id AND (sibling.last_error_code LIKE 'disconnecting:%' OR sibling.last_error_code LIKE 'account_deletion_revoke_started:%') AND sibling.updated_at >= ? AND ((social_connections.provider IN ('instagram', 'tiktok') AND sibling.remote_account_id = social_connections.remote_account_id) OR (social_connections.provider = 'facebook' AND (CASE WHEN json_valid(social_connections.metadata_json) THEN json_extract(social_connections.metadata_json, '$.grantUserId') END IS NULL OR CASE WHEN json_valid(sibling.metadata_json) THEN json_extract(sibling.metadata_json, '$.grantUserId') END IS NULL OR CASE WHEN json_valid(sibling.metadata_json) THEN json_extract(sibling.metadata_json, '$.grantUserId') END = CASE WHEN json_valid(social_connections.metadata_json) THEN json_extract(social_connections.metadata_json, '$.grantUserId') END)) OR (social_connections.provider = 'youtube' AND (CASE WHEN json_valid(social_connections.metadata_json) THEN json_extract(social_connections.metadata_json, '$.grantSubject') END IS NULL OR CASE WHEN json_valid(sibling.metadata_json) THEN json_extract(sibling.metadata_json, '$.grantSubject') END IS NULL OR CASE WHEN json_valid(sibling.metadata_json) THEN json_extract(sibling.metadata_json, '$.grantSubject') END = CASE WHEN json_valid(social_connections.metadata_json) THEN json_extract(social_connections.metadata_json, '$.grantSubject') END)))))"
    ).bind(
      disconnectToken,
      now,
      row.id,
      auth.workspaceId,
      row.credentialsEncrypted,
      row.status,
      localOnly ? 1 : 0,
      staleDisconnectBefore,
      now,
      localOnly ? 1 : 0,
      staleDisconnectBefore
    ),
    context.env.DB.prepare(
      "UPDATE publish_destinations SET status = CASE WHEN status IN ('queued', 'retry_scheduled', 'awaiting_user_action', 'reauth_required') AND remote_session_id IS NULL AND remote_post_id IS NULL AND remote_upload_url_encrypted IS NULL AND remote_url IS NULL AND outcome_unknown = 0 AND stage <> 'provider_commit_started' THEN 'cancelled' ELSE 'reconciliation_required' END, stage = CASE WHEN status IN ('queued', 'retry_scheduled', 'awaiting_user_action', 'reauth_required') AND remote_session_id IS NULL AND remote_post_id IS NULL AND remote_upload_url_encrypted IS NULL AND remote_url IS NULL AND outcome_unknown = 0 AND stage <> 'provider_commit_started' THEN 'connection_disconnected' ELSE 'connection_disconnected_outcome_unknown' END, outcome_unknown = CASE WHEN status IN ('queued', 'retry_scheduled', 'awaiting_user_action', 'reauth_required') AND remote_session_id IS NULL AND remote_post_id IS NULL AND remote_upload_url_encrypted IS NULL AND remote_url IS NULL AND outcome_unknown = 0 AND stage <> 'provider_commit_started' THEN 0 ELSE 1 END, next_poll_at = NULL, updated_at = ? WHERE connection_id = ? AND status IN ('queued', 'starting', 'transferring', 'processing', 'publishing', 'retry_scheduled', 'awaiting_user_action', 'reauth_required') AND EXISTS (SELECT 1 FROM social_connections WHERE id = ? AND credentials_encrypted = ? AND status = 'limited' AND last_error_code = ?)"
    ).bind(now, row.id, row.id, row.credentialsEncrypted, disconnectToken),
    context.env.DB.prepare(
      "UPDATE publish_attempts SET status = (SELECT status FROM publish_destinations WHERE publish_destinations.id = publish_attempts.destination_id), stage = (SELECT stage FROM publish_destinations WHERE publish_destinations.id = publish_attempts.destination_id), finished_at = ?, updated_at = ? WHERE destination_id IN (SELECT id FROM publish_destinations WHERE connection_id = ? AND status IN ('cancelled', 'reconciliation_required')) AND finished_at IS NULL AND EXISTS (SELECT 1 FROM social_connections WHERE id = ? AND credentials_encrypted = ? AND status = 'limited' AND last_error_code = ?)"
    ).bind(now, now, row.id, row.id, row.credentialsEncrypted, disconnectToken),
    context.env.DB.prepare(
      "UPDATE posts SET status = CASE WHEN NOT EXISTS (SELECT 1 FROM publish_destinations WHERE post_id = posts.id AND status <> 'published') THEN 'published' WHEN EXISTS (SELECT 1 FROM publish_destinations WHERE post_id = posts.id AND status IN ('queued', 'starting', 'transferring', 'processing', 'publishing', 'retry_scheduled')) THEN 'publishing' WHEN EXISTS (SELECT 1 FROM publish_destinations WHERE post_id = posts.id AND status = 'published') THEN 'partial_success' WHEN NOT EXISTS (SELECT 1 FROM publish_destinations WHERE post_id = posts.id AND status <> 'cancelled') THEN 'cancelled' ELSE 'failed' END, updated_at = ? WHERE id IN (SELECT post_id FROM publish_destinations WHERE connection_id = ?) AND EXISTS (SELECT 1 FROM social_connections WHERE id = ? AND credentials_encrypted = ? AND status = 'limited' AND last_error_code = ?)"
    ).bind(now, row.id, row.id, row.credentialsEncrypted, disconnectToken)
  ]);
  if (claim[0]?.meta.changes !== 1) {
    const [latest] = await db
      .select({ status: socialConnections.status })
      .from(socialConnections)
      .where(eq(socialConnections.id, row.id))
      .limit(1);
    if (latest?.status === "disconnected") {
      return context.body(null, 204);
    }
    throw new AppError(
      409,
      "connection_changed",
      "The connection changed while it was being disconnected."
    );
  }

  const stillOwnsDisconnect = async (): Promise<boolean> => {
    const [current] = await db
      .select({
        credentialsEncrypted: socialConnections.credentialsEncrypted,
        lastErrorCode: socialConnections.lastErrorCode,
        status: socialConnections.status
      })
      .from(socialConnections)
      .where(eq(socialConnections.id, row.id))
      .limit(1);
    return (
      current?.credentialsEncrypted === row.credentialsEncrypted &&
      current.status === "limited" &&
      current.lastErrorCode === disconnectToken
    );
  };

  let grantSiblingState: ActiveGrantSiblingState = "none";
  try {
    if (credentials !== null) {
      try {
        grantSiblingState = await activeGrantSiblingState(
          db,
          context.env,
          row,
          credentials
        );
      } catch {
        throw new AppError(
          409,
          "provider_grant_identity_unknown",
          "VidRelay could not confirm whether another connection shares this provider authorization. Retry, or choose local-only removal."
        );
      }
    }
    if (credentials !== null && grantSiblingState === "unknown") {
      throw new AppError(
        409,
        "provider_grant_identity_unknown",
        "Reconnect this provider account before disconnecting it so shared authorization can be handled safely."
      );
    }
    if (credentials !== null && grantSiblingState === "none") {
      if (!(await stillOwnsDisconnect())) {
        throw new AppError(
          409,
          "connection_changed",
          "The connection changed before provider revocation began."
        );
      }
      await revokeProviderCredentials(context.env, row, credentials);
    }
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === "connection_changed" ||
        error.code === "provider_grant_identity_unknown")
    ) {
      if (error.code === "provider_grant_identity_unknown") {
        await db
          .update(socialConnections)
          .set({
            lastErrorCode: error.code,
            lastErrorMessage: error.message,
            status: "limited",
            updatedAt: Date.now()
          })
          .where(
            and(
              eq(socialConnections.id, row.id),
              eq(
                socialConnections.credentialsEncrypted,
                row.credentialsEncrypted
              ),
              eq(socialConnections.lastErrorCode, disconnectToken)
            )
          );
      }
      throw error;
    }
    const outcomeUnknown =
      error instanceof ProviderError && error.outcomeUnknown;
    await db
      .update(socialConnections)
      .set({
        lastErrorCode: outcomeUnknown
          ? disconnectToken
          : "provider_revoke_failed",
        lastErrorMessage:
          "Provider revocation was not confirmed. Retry or explicitly remove only VidRelay's stored credentials.",
        status: "limited",
        updatedAt: Date.now()
      })
      .where(
        and(
          eq(socialConnections.id, row.id),
          eq(socialConnections.credentialsEncrypted, row.credentialsEncrypted),
          eq(socialConnections.lastErrorCode, disconnectToken)
        )
      );
    const [latest] = await db
      .select({ status: socialConnections.status })
      .from(socialConnections)
      .where(eq(socialConnections.id, row.id))
      .limit(1);
    if (latest?.status === "disconnected") {
      return context.body(null, 204);
    }
    safeLog("warn", "connection.provider_revoke_failed", {
      connectionId: row.id,
      error: error instanceof Error ? error.message : "unknown",
      provider: row.provider,
      requestId: context.get("requestId")
    });
    throw new AppError(
      409,
      "provider_revocation_unconfirmed",
      "The provider did not confirm revocation. Retry, or remove VidRelay from the provider and choose local-only removal."
    );
  }

  if (!(await stillOwnsDisconnect())) {
    const [claimedConnection] = await db
      .select({ status: socialConnections.status })
      .from(socialConnections)
      .where(eq(socialConnections.id, row.id))
      .limit(1);
    if (claimedConnection?.status === "disconnected") {
      return context.body(null, 204);
    }
    throw new AppError(
      409,
      "connection_changed",
      "The connection changed while it was being disconnected. Reconnect it before publishing."
    );
  }

  const revokedCredentials: StoredCredentials = {
    accessToken: "revoked",
    expiresAt: null,
    refreshExpiresAt: null,
    refreshToken: null,
    tokenType: null,
    userAccessToken: null
  };
  const updated = await db
    .update(socialConnections)
    .set({
      credentialsEncrypted: await encodeCredentials(
        context.env,
        revokedCredentials
      ),
      disconnectedAt: now,
      expiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      status: "disconnected",
      updatedAt: now
    })
    .where(
      and(
        eq(socialConnections.id, row.id),
        eq(socialConnections.credentialsEncrypted, row.credentialsEncrypted),
        eq(socialConnections.lastErrorCode, disconnectToken)
      )
    )
    .returning({ id: socialConnections.id });
  if (updated.length === 0) {
    const [latest] = await db
      .select({ status: socialConnections.status })
      .from(socialConnections)
      .where(eq(socialConnections.id, row.id))
      .limit(1);
    if (latest?.status === "disconnected") {
      return context.body(null, 204);
    }
    throw new AppError(
      409,
      "connection_changed",
      "The connection changed while it was being disconnected."
    );
  }
  try {
    await writeAuditEvent(db, {
      action: "connection.disconnected",
      actorUserId: auth.userId,
      entityId: row.id,
      entityType: "connection",
      metadata: {
        provider: row.provider,
        providerRevocation: localOnly
          ? "unconfirmed_local_only"
          : grantSiblingState === "shared"
            ? "shared_grant_retained"
            : "confirmed"
      },
      workspaceId: auth.workspaceId
    });
  } catch (error) {
    safeLog("error", "connection.audit_failed", {
      connectionId: row.id,
      error: error instanceof Error ? error.message : "unknown",
      requestId: context.get("requestId")
    });
  }

  return context.body(null, 204);
});
