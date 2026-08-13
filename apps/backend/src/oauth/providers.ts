import type { ConnectionStatus, Platform } from "@vidrelay/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Bindings } from "../env";
import type { Database } from "../db/client";
import { socialConnections } from "../db/schema";
import { requireSecret } from "../env";
import { sha256Base64Url } from "../lib/crypto";
import { ProviderError } from "../lib/errors";
import { formBody, providerJson } from "../platforms/http";
import {
  decodeCredentials,
  encodeCredentials,
  type StoredCredentials
} from "../platforms/credentials";
import { revokeProviderGrant } from "../platforms/revoke";
import { latestTiktokRemoval } from "../platforms/tiktok-removals";

interface DiscoveryContext {
  bindings: Bindings;
  code: string;
  codeVerifier: string | null;
  db: Database;
  userId: string;
  workspaceId: string;
}

interface AuthorizationRequest {
  codeVerifier: string | null;
  url: string;
}

interface DiscoveredConnection {
  avatarUrl: string | null;
  connectedByUserId: string;
  credentials: StoredCredentials;
  displayName: string;
  expiresAt: number | null;
  metadata: Record<string, unknown>;
  platform: Platform;
  remoteAccountId: string;
  scopes: string[];
  status?: ConnectionStatus;
  workspaceId: string;
}

interface PreparedConnection {
  credentialsEncrypted: string;
  id: string;
  input: DiscoveredConnection;
  previousCredentialsEncrypted: string | null;
}

interface ActiveStoredMetaGrant {
  credentialsEncrypted: string;
  metadataJson: string;
  remoteAccountId: string;
}

const redirectUri = (bindings: Bindings, platform: Platform): string =>
  new URL(
    "/api/oauth/" + platform + "/callback",
    bindings.PUBLIC_API_ORIGIN
  ).toString();

const baseCredential = (input: {
  accessToken: string;
  expiresAt?: number | null | undefined;
  refreshExpiresAt?: number | null | undefined;
  refreshToken?: string | null | undefined;
  tokenType?: string | null | undefined;
  userAccessToken?: string | null | undefined;
}): StoredCredentials => ({
  accessToken: input.accessToken,
  expiresAt: input.expiresAt ?? null,
  refreshExpiresAt: input.refreshExpiresAt ?? null,
  refreshToken: input.refreshToken ?? null,
  tokenType: input.tokenType ?? null,
  userAccessToken: input.userAccessToken ?? null
});

const facebookScopes = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts"
] as const;
const instagramScopes = [
  "instagram_business_basic",
  "instagram_business_content_publish"
] as const;
const youtubeScopes = [
  "https://www.googleapis.com/auth/youtube.upload"
] as const;
const tiktokScopes = ["user.info.basic", "video.publish"] as const;

export const createAuthorizationRequest = async (
  bindings: Bindings,
  platform: Platform,
  state: string
): Promise<AuthorizationRequest> => {
  const callback = redirectUri(bindings, platform);

  if (platform === "facebook") {
    const url = new URL(
      "https://www.facebook.com/" +
        bindings.META_GRAPH_VERSION +
        "/dialog/oauth"
    );
    url.searchParams.set(
      "client_id",
      requireSecret(bindings.META_APP_ID, "META_APP_ID")
    );
    url.searchParams.set("redirect_uri", callback);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", facebookScopes.join(","));
    url.searchParams.set("state", state);
    return { codeVerifier: null, url: url.toString() };
  }

  if (platform === "instagram") {
    const url = new URL("https://www.instagram.com/oauth/authorize");
    url.searchParams.set(
      "client_id",
      requireSecret(bindings.INSTAGRAM_APP_ID, "INSTAGRAM_APP_ID")
    );
    url.searchParams.set("enable_fb_login", "0");
    url.searchParams.set("force_authentication", "1");
    url.searchParams.set("redirect_uri", callback);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", instagramScopes.join(","));
    url.searchParams.set("state", state);
    return { codeVerifier: null, url: url.toString() };
  }

  if (platform === "youtube") {
    const codeVerifier = crypto.randomUUID() + crypto.randomUUID();
    const codeChallenge = await sha256Base64Url(codeVerifier);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set(
      "client_id",
      requireSecret(bindings.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID")
    );
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("redirect_uri", callback);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", youtubeScopes.join(" "));
    url.searchParams.set("state", state);
    return { codeVerifier, url: url.toString() };
  }

  const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
  url.searchParams.set(
    "client_key",
    requireSecret(bindings.TIKTOK_CLIENT_KEY, "TIKTOK_CLIENT_KEY")
  );
  url.searchParams.set("disable_auto_auth", "1");
  url.searchParams.set("redirect_uri", callback);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", tiktokScopes.join(","));
  url.searchParams.set("state", state);
  return { codeVerifier: null, url: url.toString() };
};

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional()
});

const exchangedAccessTokenSchema = z.object({
  access_token: z.string().min(1)
});

const existingConnection = async (
  context: DiscoveryContext,
  connection: DiscoveredConnection
): Promise<
  | { credentialsEncrypted: string; id: string }
  | undefined
> => {
  const [existing] = await context.db
    .select({
      credentialsEncrypted: socialConnections.credentialsEncrypted,
      id: socialConnections.id
    })
    .from(socialConnections)
    .where(
      and(
        eq(socialConnections.workspaceId, connection.workspaceId),
        eq(socialConnections.provider, connection.platform),
        eq(socialConnections.remoteAccountId, connection.remoteAccountId)
      )
    )
    .limit(1);
  return existing;
};

const preserveRefreshToken = async (
  bindings: Bindings,
  existingCredentialsEncrypted: string | null,
  credentials: StoredCredentials
): Promise<StoredCredentials> => {
  if (
    credentials.refreshToken !== null ||
    existingCredentialsEncrypted === null
  ) {
    return credentials;
  }
  const previous = await decodeCredentials(
    bindings,
    existingCredentialsEncrypted
  );
  return previous.refreshToken === null
    ? credentials
    : {
        ...credentials,
        refreshExpiresAt: previous.refreshExpiresAt,
        refreshToken: previous.refreshToken
      };
};

const connectionStatement = (
  context: DiscoveryContext,
  prepared: PreparedConnection,
  now: number
): D1PreparedStatement => {
  const authorizedAt = prepared.input.metadata.authorizedAt;
  const tiktokAuthorizedAt =
    prepared.input.platform === "tiktok" &&
    typeof authorizedAt === "number" &&
    Number.isSafeInteger(authorizedAt)
      ? authorizedAt
      : null;
  const tiktokLifecycleFreshAfter =
    tiktokAuthorizedAt === null
      ? null
      : tiktokAuthorizedAt - 15 * 60 * 1000;
  const connectionExisted = prepared.previousCredentialsEncrypted !== null;
  const expectedCredentials =
    prepared.previousCredentialsEncrypted ?? prepared.credentialsEncrypted;
  const tiktokRemovalPrefix =
    tiktokAuthorizedAt === null
      ? null
      : "authorization.removed:" + prepared.input.remoteAccountId + ":";
  const tiktokRemovalGuard =
    tiktokRemovalPrefix === null
      ? ""
      : " AND NOT EXISTS (SELECT 1 FROM webhook_events WHERE provider = 'tiktok' AND provider_event_id IS NOT NULL AND instr(provider_event_id, ?) = 1 AND status IN ('received', 'processed', 'failed') AND CAST(substr(provider_event_id, length(?) + 1) AS INTEGER) * 1000 >= ?)";
  const tiktokDisconnectGuard =
    tiktokAuthorizedAt === null
      ? ""
      : " AND NOT EXISTS (SELECT 1 FROM social_connections AS disconnecting_connection WHERE disconnecting_connection.provider = 'tiktok' AND disconnecting_connection.remote_account_id = ? AND (disconnecting_connection.last_error_code LIKE 'disconnecting:%' OR disconnecting_connection.last_error_code LIKE 'account_deletion_revoke_started:%') AND disconnecting_connection.updated_at >= ?)";
  return context.bindings.DB.prepare(
    "INSERT INTO social_connections (id, workspace_id, connected_by_user_id, provider, remote_account_id, display_name, avatar_url, credentials_encrypted, key_version, scopes_json, metadata_json, status, expires_at, last_checked_at, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ? FROM users INNER JOIN memberships ON memberships.user_id = users.id INNER JOIN workspaces ON workspaces.id = memberships.workspace_id WHERE users.id = ? AND users.status = 'active' AND workspaces.id = ? AND workspaces.status = 'active' AND ((? IS NULL AND NOT EXISTS (SELECT 1 FROM social_connections WHERE workspace_id = ? AND provider = ? AND remote_account_id = ?)) OR EXISTS (SELECT 1 FROM social_connections WHERE id = ? AND credentials_encrypted = ? AND (? IS NULL OR provider <> 'tiktok' OR status <> 'disconnected' OR last_error_code <> 'authorization_removed' OR disconnected_at IS NULL OR disconnected_at < ?)) OR (? IS NOT NULL AND EXISTS (SELECT 1 FROM social_connections WHERE id = ? AND provider = 'tiktok' AND status = 'disconnected' AND last_error_code = 'authorization_removed' AND disconnected_at IS NOT NULL AND disconnected_at < ?)))" +
      tiktokRemovalGuard +
      tiktokDisconnectGuard +
      " ON CONFLICT(workspace_id, provider, remote_account_id) DO UPDATE SET connected_by_user_id = excluded.connected_by_user_id, display_name = excluded.display_name, avatar_url = excluded.avatar_url, credentials_encrypted = excluded.credentials_encrypted, key_version = 1, scopes_json = excluded.scopes_json, metadata_json = excluded.metadata_json, status = excluded.status, expires_at = excluded.expires_at, last_checked_at = excluded.last_checked_at, last_error_code = NULL, last_error_message = NULL, disconnected_at = NULL, refresh_lease_id = NULL, refresh_lease_expires_at = NULL, updated_at = excluded.updated_at WHERE social_connections.credentials_encrypted = ? AND ? = 1 AND ((social_connections.provider <> 'tiktok' AND (social_connections.last_error_code IS NULL OR social_connections.last_error_code NOT LIKE 'disconnecting:%')) OR (social_connections.provider = 'tiktok' AND (social_connections.last_error_code IS NULL OR (social_connections.last_error_code NOT LIKE 'disconnecting:%' AND social_connections.last_error_code NOT LIKE 'account_deletion_revoke_started:%') OR social_connections.updated_at < ?)))"
  ).bind(
    prepared.id,
    prepared.input.workspaceId,
    prepared.input.connectedByUserId,
    prepared.input.platform,
    prepared.input.remoteAccountId,
    prepared.input.displayName,
    prepared.input.avatarUrl,
    prepared.credentialsEncrypted,
    JSON.stringify(prepared.input.scopes),
    JSON.stringify(prepared.input.metadata),
    prepared.input.status ?? "connected",
    prepared.input.expiresAt,
    now,
    now,
    now,
    context.userId,
    context.workspaceId,
    prepared.previousCredentialsEncrypted,
    prepared.input.workspaceId,
    prepared.input.platform,
    prepared.input.remoteAccountId,
    prepared.id,
    prepared.previousCredentialsEncrypted,
    tiktokAuthorizedAt,
    tiktokAuthorizedAt,
    tiktokAuthorizedAt,
    prepared.id,
    tiktokAuthorizedAt,
    ...(tiktokRemovalPrefix === null
      ? []
      : [
          tiktokRemovalPrefix,
          tiktokRemovalPrefix,
          tiktokAuthorizedAt,
          prepared.input.remoteAccountId,
          tiktokLifecycleFreshAfter
        ]),
    expectedCredentials,
    connectionExisted ? 1 : 0,
    tiktokLifecycleFreshAfter
  );
};

const connectionGuardStatement = (
  context: DiscoveryContext,
  prepared: PreparedConnection
): D1PreparedStatement =>
  // Force the D1 batch to roll back when a guarded insert/update saved no row.
  context.bindings.DB.prepare(
    "SELECT CASE WHEN EXISTS (SELECT 1 FROM social_connections WHERE id = ? AND credentials_encrypted = ?) THEN 1 ELSE json_extract('invalid', '$') END AS connection_saved"
  ).bind(
    prepared.id,
    prepared.credentialsEncrypted
  );

const persistConnections = async (
  context: DiscoveryContext,
  connections: DiscoveredConnection[]
): Promise<void> => {
  if (connections.length === 0) {
    return;
  }

  const preparedConnections: PreparedConnection[] = [];
  for (const connection of connections) {
    const existing = await existingConnection(context, connection);
    const credentials = await preserveRefreshToken(
      context.bindings,
      existing?.credentialsEncrypted ?? null,
      connection.credentials
    );

    preparedConnections.push({
      credentialsEncrypted: await encodeCredentials(
        context.bindings,
        credentials
      ),
      id: existing?.id ?? crypto.randomUUID(),
      input: { ...connection, credentials },
      previousCredentialsEncrypted: existing?.credentialsEncrypted ?? null
    });
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const prepared of preparedConnections) {
    statements.push(connectionStatement(context, prepared, now));
    // The guard deliberately raises a JSON error if the preceding CAS wrote no
    // row, making D1 roll back the batch instead of committing partial accounts.
    statements.push(connectionGuardStatement(context, prepared));
  }

  try {
    await context.bindings.DB.batch(statements);
  } catch (error) {
    const activeAccount = await context.bindings.DB.prepare(
      "SELECT 1 AS active FROM users INNER JOIN memberships ON memberships.user_id = users.id INNER JOIN workspaces ON workspaces.id = memberships.workspace_id WHERE users.id = ? AND users.status = 'active' AND workspaces.id = ? AND workspaces.status = 'active' LIMIT 1"
    )
      .bind(context.userId, context.workspaceId)
      .first<{ active: number }>();
    if (activeAccount === null) {
      throw new ProviderError({
        code: "account_not_active",
        message:
          "The account was closed while provider authorization was completing."
      });
    }
    throw error instanceof Error
      ? error
      : new Error("Provider connections could not be saved.");
  }
};

const revokeAfterFailure = async (
  bindings: Bindings,
  platform: Platform,
  credentials: StoredCredentials,
  originalError: Error
): Promise<never> => {
  try {
    await revokeProviderGrant(bindings, platform, credentials);
  } catch (revocationError) {
    const revocationFailure =
      revocationError instanceof Error
        ? revocationError
        : new Error("The provider grant could not be revoked.");
    throw new AggregateError(
      [originalError, revocationFailure],
      "Provider authorization failed and the new grant could not be revoked."
    );
  }
  throw originalError;
};

type MetaPlatform = "facebook" | "instagram";

const activeStoredMetaGrants = async (
  context: DiscoveryContext,
  platform: MetaPlatform
): Promise<ActiveStoredMetaGrant[]> => {
  const staleRemovalBefore = Date.now() - 15 * 60 * 1000;
  return await context.db
    .select({
      credentialsEncrypted: socialConnections.credentialsEncrypted,
      metadataJson: socialConnections.metadataJson,
      remoteAccountId: socialConnections.remoteAccountId
    })
    .from(socialConnections)
    .where(
      and(
        eq(socialConnections.provider, platform),
        inArray(socialConnections.status, ["connected", "limited"]),
        sql`(${socialConnections.lastErrorCode} IS NULL OR (${socialConnections.lastErrorCode} <> 'account_deletion_revoke_completed' AND ((${socialConnections.lastErrorCode} <> 'disconnecting' AND ${socialConnections.lastErrorCode} NOT LIKE 'disconnecting:%' AND ${socialConnections.lastErrorCode} NOT LIKE 'account_deletion_revoke_started%') OR ${socialConnections.updatedAt} < ${staleRemovalBefore})))`,
        sql`EXISTS (SELECT 1 FROM workspaces INNER JOIN users ON users.id = ${socialConnections.connectedByUserId} WHERE workspaces.id = ${socialConnections.workspaceId} AND workspaces.status = 'active' AND users.status = 'active')`
      )
    );
};

const facebookGrantUserId = (metadataJson: string): string | null => {
  try {
    const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
    if (
      typeof metadata.grantUserId !== "string" ||
      metadata.grantUserId.length === 0
    ) {
      return null;
    }
    return metadata.grantUserId;
  } catch {
    return null;
  }
};

const storedMetaGrantMayBeShared = async (
  context: DiscoveryContext,
  platform: MetaPlatform,
  credentials: StoredCredentials,
  remoteGrantId: string | null
): Promise<boolean> => {
  if (remoteGrantId === null) {
    return true;
  }
  const storedGrants = await activeStoredMetaGrants(context, platform);
  if (storedGrants.length === 0) {
    return false;
  }

  const candidateTokens = new Set(
    [credentials.accessToken, credentials.userAccessToken].filter(
      (token): token is string => token !== null
    )
  );
  for (const storedGrant of storedGrants) {
    if (
      platform === "instagram" &&
      storedGrant.remoteAccountId === remoteGrantId
    ) {
      return true;
    }

    if (platform === "facebook") {
      const storedGrantUserId = facebookGrantUserId(
        storedGrant.metadataJson
      );
      if (storedGrantUserId === remoteGrantId) {
        return true;
      }
      if (storedGrantUserId === null) {
        return true;
      }
    }

    const storedCredentials = await decodeCredentials(
      context.bindings,
      storedGrant.credentialsEncrypted
    );
    if (
      candidateTokens.has(storedCredentials.accessToken) ||
      (storedCredentials.userAccessToken !== null &&
        candidateTokens.has(storedCredentials.userAccessToken))
    ) {
      return true;
    }
  }
  return false;
};

const revokeMetaAfterFailure = async (
  context: DiscoveryContext,
  platform: MetaPlatform,
  credentials: StoredCredentials,
  remoteGrantId: string | null,
  originalError: Error
): Promise<never> => {
  let sharedGrant: boolean;
  try {
    sharedGrant = await storedMetaGrantMayBeShared(
      context,
      platform,
      credentials,
      remoteGrantId
    );
  } catch (inspectionError) {
    const inspectionFailure =
      inspectionError instanceof Error
        ? inspectionError
        : new Error("Stored provider grants could not be inspected.");
    throw new AggregateError(
      [originalError, inspectionFailure],
      "Provider authorization failed and the new grant could not be safely distinguished from stored grants."
    );
  }
  if (sharedGrant) {
    throw originalError;
  }
  return await revokeAfterFailure(
    context.bindings,
    platform,
    credentials,
    originalError
  );
};

const connectFacebook = async (context: DiscoveryContext): Promise<number> => {
  const appId = requireSecret(context.bindings.META_APP_ID, "META_APP_ID");
  const appSecret = requireSecret(
    context.bindings.META_APP_SECRET,
    "META_APP_SECRET"
  );
  const callback = redirectUri(context.bindings, "facebook");
  const exchangeUrl = new URL(
    "https://graph.facebook.com/" +
      context.bindings.META_GRAPH_VERSION +
      "/oauth/access_token"
  );
  exchangeUrl.searchParams.set("client_id", appId);
  exchangeUrl.searchParams.set("client_secret", appSecret);
  exchangeUrl.searchParams.set("code", context.code);
  exchangeUrl.searchParams.set("redirect_uri", callback);

  let grantCredentials: StoredCredentials | null = null;
  let grantUserId: string | null = null;
  try {
    const shortTokenResponse = await providerJson<unknown>(
      exchangeUrl.toString(),
      { method: "GET" },
      {
        operation: "facebook_token_exchange"
      }
    );
    const shortRevocable = exchangedAccessTokenSchema.parse(
      shortTokenResponse
    );
    grantCredentials = baseCredential({
      accessToken: shortRevocable.access_token,
      userAccessToken: shortRevocable.access_token
    });
    const shortToken = tokenSchema.parse(shortTokenResponse);

    const longUrl = new URL(exchangeUrl.origin + exchangeUrl.pathname);
    longUrl.searchParams.set("client_id", appId);
    longUrl.searchParams.set("client_secret", appSecret);
    longUrl.searchParams.set("fb_exchange_token", shortToken.access_token);
    longUrl.searchParams.set("grant_type", "fb_exchange_token");
    const longTokenResponse = await providerJson<unknown>(
      longUrl.toString(),
      { method: "GET" },
      {
        operation: "facebook_long_token_exchange"
      }
    );
    const longRevocable = exchangedAccessTokenSchema.parse(longTokenResponse);
    grantCredentials = baseCredential({
      accessToken: longRevocable.access_token,
      userAccessToken: longRevocable.access_token
    });
    const longToken = tokenSchema.parse(longTokenResponse);
    grantCredentials = baseCredential({
      accessToken: longToken.access_token,
      refreshToken: longToken.refresh_token,
      tokenType: longToken.token_type,
      userAccessToken: longToken.access_token
    });
    const grantUser = z
      .object({ id: z.union([z.string(), z.number()]).transform(String) })
      .parse(
        await providerJson<unknown>(
          "https://graph.facebook.com/" +
            context.bindings.META_GRAPH_VERSION +
            "/me?fields=id",
          {
            headers: { Authorization: "Bearer " + longToken.access_token },
            method: "GET"
          },
          { operation: "facebook_grant_identity" }
        )
      );
    grantUserId = grantUser.id;

    const pagesSchema = z.object({
      data: z.array(
        z.object({
          access_token: z.string().min(1),
          id: z.string().min(1),
          name: z.string().min(1),
          picture: z
            .object({
              data: z.object({ url: z.string().url().optional() }).optional()
            })
            .optional(),
          tasks: z.array(z.string()).optional()
        })
      )
    });
    const pagesUrl = new URL(
      "https://graph.facebook.com/" +
        context.bindings.META_GRAPH_VERSION +
        "/me/accounts"
    );
    pagesUrl.searchParams.set(
      "fields",
      "id,name,access_token,tasks,picture{url}"
    );
    pagesUrl.searchParams.set("limit", "100");
    const pages = pagesSchema.parse(
      await providerJson<unknown>(
        pagesUrl.toString(),
        {
          headers: { Authorization: "Bearer " + longToken.access_token },
          method: "GET"
        },
        { operation: "facebook_page_discovery" }
      )
    );
    const expiresAt =
      longToken.expires_in === undefined
        ? null
        : Date.now() + longToken.expires_in * 1000;
    const connections = pages.data.map(page => {
      const tasks = page.tasks ?? [];
      const canPublish = tasks.some(task =>
        [
          "CREATE_CONTENT",
          "MANAGE",
          "PROFILE_PLUS_CREATE_CONTENT",
          "PROFILE_PLUS_FULL_CONTROL",
          "PROFILE_PLUS_MANAGE"
        ].includes(task)
      );
      return {
        avatarUrl: page.picture?.data?.url ?? null,
        connectedByUserId: context.userId,
        credentials: baseCredential({
          accessToken: page.access_token,
          expiresAt,
          tokenType: longToken.token_type,
          userAccessToken: longToken.access_token
        }),
        displayName: page.name,
        expiresAt,
        metadata: { grantUserId: grantUser.id, tasks },
        platform: "facebook" as const,
        remoteAccountId: page.id,
        scopes: [...facebookScopes],
        status: canPublish ? ("connected" as const) : ("limited" as const),
        workspaceId: context.workspaceId
      };
    });
    if (connections.length === 0) {
      const credentials = grantCredentials;
      grantCredentials = null;
      if (
        !(await storedMetaGrantMayBeShared(
          context,
          "facebook",
          credentials,
          grantUserId
        ))
      ) {
        await revokeProviderGrant(context.bindings, "facebook", credentials);
      }
      return 0;
    }

    await persistConnections(context, connections);
    return connections.length;
  } catch (error) {
    const failure =
      error instanceof Error
        ? error
        : new Error("Facebook authorization failed.");
    if (grantCredentials === null) {
      throw failure;
    }
    return await revokeMetaAfterFailure(
      context,
      "facebook",
      grantCredentials,
      grantUserId,
      failure
    );
  }
};

const connectInstagram = async (context: DiscoveryContext): Promise<number> => {
  const appId = requireSecret(
    context.bindings.INSTAGRAM_APP_ID,
    "INSTAGRAM_APP_ID"
  );
  const appSecret = requireSecret(
    context.bindings.INSTAGRAM_APP_SECRET,
    "INSTAGRAM_APP_SECRET"
  );
  let grantCredentials: StoredCredentials | null = null;
  let grantRemoteAccountId: string | null = null;
  try {
    const shortTokenResponse = await providerJson<unknown>(
      "https://api.instagram.com/oauth/access_token",
      {
        body: formBody({
          client_id: appId,
          client_secret: appSecret,
          code: context.code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri(context.bindings, "instagram")
        }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST"
      },
      { operation: "instagram_token_exchange" }
    );
    const shortRevocable = exchangedAccessTokenSchema.parse(
      shortTokenResponse
    );
    grantCredentials = baseCredential({
      accessToken: shortRevocable.access_token
    });
    const shortToken = z
      .object({
        access_token: z.string().min(1),
        permissions: z.string().optional(),
        user_id: z.union([z.string(), z.number()]).transform(String)
      })
      .parse(shortTokenResponse);
    grantRemoteAccountId = shortToken.user_id;

    const longUrl = new URL("https://graph.instagram.com/access_token");
    longUrl.searchParams.set("access_token", shortToken.access_token);
    longUrl.searchParams.set("client_secret", appSecret);
    longUrl.searchParams.set("grant_type", "ig_exchange_token");
    const longTokenResponse = await providerJson<unknown>(
      longUrl.toString(),
      { method: "GET" },
      {
        operation: "instagram_long_token_exchange"
      }
    );
    const longRevocable = exchangedAccessTokenSchema.parse(longTokenResponse);
    grantCredentials = baseCredential({
      accessToken: longRevocable.access_token
    });
    const longToken = tokenSchema.parse(longTokenResponse);
    grantCredentials = baseCredential({
      accessToken: longToken.access_token,
      refreshToken: longToken.refresh_token,
      tokenType: longToken.token_type
    });
    const profileUrl = new URL(
      "https://graph.instagram.com/" +
        context.bindings.META_GRAPH_VERSION +
        "/me"
    );
    profileUrl.searchParams.set(
      "fields",
      "id,user_id,username,name,account_type,profile_picture_url"
    );
    const profile = z
      .object({
        account_type: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
        profile_picture_url: z.string().url().optional(),
        user_id: z.union([z.string(), z.number()]).transform(String).optional(),
        username: z.string().optional()
      })
      .parse(
        await providerJson<unknown>(
          profileUrl.toString(),
          {
            headers: { Authorization: "Bearer " + longToken.access_token },
            method: "GET"
          },
          { operation: "instagram_profile_discovery" }
        )
      );
    const remoteId = profile.user_id ?? profile.id ?? shortToken.user_id;
    grantRemoteAccountId = remoteId;
    const expiresAt =
      longToken.expires_in === undefined
        ? null
        : Date.now() + longToken.expires_in * 1000;

    await persistConnections(context, [
      {
        avatarUrl: profile.profile_picture_url ?? null,
        connectedByUserId: context.userId,
        credentials: baseCredential({
          accessToken: longToken.access_token,
          expiresAt,
          tokenType: longToken.token_type
        }),
        displayName: profile.username ?? profile.name ?? "Instagram account",
        expiresAt,
        metadata: { accountType: profile.account_type ?? "professional" },
        platform: "instagram",
        remoteAccountId: remoteId,
        scopes: shortToken.permissions?.split(",").filter(Boolean) ?? [
          ...instagramScopes
        ],
        workspaceId: context.workspaceId
      }
    ]);
    return 1;
  } catch (error) {
    const failure =
      error instanceof Error
        ? error
        : new Error("Instagram authorization failed.");
    if (grantCredentials === null) {
      throw failure;
    }
    return await revokeMetaAfterFailure(
      context,
      "instagram",
      grantCredentials,
      grantRemoteAccountId,
      failure
    );
  }
};

const connectYoutube = async (context: DiscoveryContext): Promise<number> => {
  let grantCredentials: StoredCredentials | null = null;
  try {
    const tokenResponse = await providerJson<unknown>(
      "https://oauth2.googleapis.com/token",
      {
        body: formBody({
          client_id: requireSecret(
            context.bindings.GOOGLE_CLIENT_ID,
            "GOOGLE_CLIENT_ID"
          ),
          client_secret: requireSecret(
            context.bindings.GOOGLE_CLIENT_SECRET,
            "GOOGLE_CLIENT_SECRET"
          ),
          code: context.code,
          code_verifier: context.codeVerifier ?? "",
          grant_type: "authorization_code",
          redirect_uri: redirectUri(context.bindings, "youtube")
        }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST"
      },
      { operation: "youtube_token_exchange" }
    );
    const revocable = exchangedAccessTokenSchema.parse(tokenResponse);
    grantCredentials = baseCredential({
      accessToken: revocable.access_token
    });
    const token = tokenSchema.parse(tokenResponse);
    grantCredentials = baseCredential({
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenType: token.token_type
    });
    const channels = z
      .object({
        items: z.array(
          z.object({
            id: z.string(),
            snippet: z.object({
              customUrl: z.string().optional(),
              thumbnails: z
                .object({
                  default: z.object({ url: z.string().url() }).optional()
                })
                .optional(),
              title: z.string()
            })
          })
        )
      })
      .parse(
        await providerJson<unknown>(
          "https://www.googleapis.com/youtube/v3/channels?part=id%2Csnippet&mine=true",
          {
            headers: { Authorization: "Bearer " + token.access_token },
            method: "GET"
          },
          { operation: "youtube_channel_discovery" }
        )
      );
    const expiresAt =
      token.expires_in === undefined
        ? null
        : Date.now() + token.expires_in * 1000;
    const connections = channels.items.map(channel => ({
      avatarUrl: channel.snippet.thumbnails?.default?.url ?? null,
      connectedByUserId: context.userId,
      credentials: baseCredential({
        accessToken: token.access_token,
        expiresAt,
        refreshToken: token.refresh_token,
        tokenType: token.token_type
      }),
      displayName: channel.snippet.title,
      expiresAt,
      metadata: { customUrl: channel.snippet.customUrl ?? null },
      platform: "youtube" as const,
      remoteAccountId: channel.id,
      scopes: token.scope?.split(" ").filter(Boolean) ?? [...youtubeScopes],
      workspaceId: context.workspaceId
    }));
    if (connections.length === 0) {
      const credentials = grantCredentials;
      grantCredentials = null;
      await revokeProviderGrant(context.bindings, "youtube", credentials);
      return 0;
    }

    await persistConnections(context, connections);
    return connections.length;
  } catch (error) {
    const failure =
      error instanceof Error
        ? error
        : new Error("YouTube authorization failed.");
    if (grantCredentials === null) {
      throw failure;
    }
    return await revokeAfterFailure(
      context.bindings,
      "youtube",
      grantCredentials,
      failure
    );
  }
};

const connectTiktok = async (context: DiscoveryContext): Promise<number> => {
  let grantCredentials: StoredCredentials | null = null;
  let authorizationStartedAt: number | null = null;
  let discoveredRemoteAccountId: string | null = null;
  try {
    const tokenResponse = await providerJson<unknown>(
      "https://open.tiktokapis.com/v2/oauth/token/",
      {
        body: formBody({
          client_key: requireSecret(
            context.bindings.TIKTOK_CLIENT_KEY,
            "TIKTOK_CLIENT_KEY"
          ),
          client_secret: requireSecret(
            context.bindings.TIKTOK_CLIENT_SECRET,
            "TIKTOK_CLIENT_SECRET"
          ),
          code: context.code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri(context.bindings, "tiktok")
        }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST"
      },
      { operation: "tiktok_token_exchange" }
    );
    const revocable = exchangedAccessTokenSchema.parse(tokenResponse);
    grantCredentials = baseCredential({
      accessToken: revocable.access_token
    });
    const token = z
      .object({
        access_token: z.string().min(1),
        expires_in: z.number(),
        open_id: z.string().min(1),
        refresh_expires_in: z.number(),
        refresh_token: z.string().min(1),
        scope: z.string(),
        token_type: z.string().optional()
      })
      .parse(tokenResponse);
    const authorizedAt = Math.floor(Date.now() / 1000) * 1000;
    authorizationStartedAt = authorizedAt;
    discoveredRemoteAccountId = token.open_id;
    grantCredentials = baseCredential({
      accessToken: token.access_token,
      expiresAt: authorizedAt + token.expires_in * 1000,
      refreshExpiresAt: authorizedAt + token.refresh_expires_in * 1000,
      refreshToken: token.refresh_token,
      tokenType: token.token_type
    });
    const profile = z
      .object({
        data: z.object({
          user: z.object({
            avatar_url: z.string().url().optional(),
            display_name: z.string().optional(),
            open_id: z.string().optional(),
            union_id: z.string().optional()
          })
        }),
        error: z.object({ code: z.string() }).optional()
      })
      .parse(
        await providerJson<unknown>(
          "https://open.tiktokapis.com/v2/user/info/?fields=open_id%2Cunion_id%2Cavatar_url%2Cdisplay_name",
          {
            headers: { Authorization: "Bearer " + token.access_token },
            method: "GET"
          },
          { operation: "tiktok_profile_discovery" }
        )
      );
    if (profile.error !== undefined && profile.error.code !== "ok") {
      throw new Error("TikTok returned an unsuccessful profile response.");
    }

    const user = profile.data.user;
    const remoteAccountId = user.open_id ?? token.open_id;
    discoveredRemoteAccountId = remoteAccountId;
    const expiresAt = authorizedAt + token.expires_in * 1000;
    await persistConnections(context, [
      {
        avatarUrl: user.avatar_url ?? null,
        connectedByUserId: context.userId,
        credentials: grantCredentials,
        displayName: user.display_name ?? "TikTok creator",
        expiresAt,
        metadata: { authorizedAt, unionId: user.union_id ?? null },
        platform: "tiktok",
        remoteAccountId,
        scopes: token.scope.split(",").filter(Boolean),
        workspaceId: context.workspaceId
      }
    ]);
    const removedAt = await latestTiktokRemoval(
      context.bindings,
      remoteAccountId
    );
    if (removedAt !== null && removedAt >= authorizedAt) {
      throw new ProviderError({
        code: "tiktok_authorization_removed",
        message:
          "TikTok removed this authorization while the connection was completing."
      });
    }

    return 1;
  } catch (error) {
    const failure =
      error instanceof Error
        ? error
        : new Error("TikTok authorization failed.");
    if (grantCredentials === null) {
      throw failure;
    }
    if (
      failure instanceof ProviderError &&
      failure.code === "tiktok_authorization_removed"
    ) {
      throw failure;
    }
    if (
      discoveredRemoteAccountId !== null &&
      authorizationStartedAt !== null
    ) {
      const staleDisconnectBefore =
        authorizationStartedAt - 15 * 60 * 1000;
      const removedAt = await latestTiktokRemoval(
        context.bindings,
        discoveredRemoteAccountId
      );
      if (removedAt !== null && removedAt >= authorizationStartedAt) {
        throw new ProviderError({
          code: "tiktok_authorization_removed",
          message:
            "TikTok removed this authorization while the connection was completing."
        });
      }
      const disconnectingGrant = await context.bindings.DB.prepare(
        "SELECT 1 AS active FROM social_connections WHERE provider = 'tiktok' AND remote_account_id = ? AND (last_error_code LIKE 'disconnecting:%' OR last_error_code LIKE 'account_deletion_revoke_started:%') AND updated_at >= ? LIMIT 1"
      )
        .bind(discoveredRemoteAccountId, staleDisconnectBefore)
        .first<{ active: number }>();
      if (disconnectingGrant !== null) {
        throw failure;
      }
      const activeGrant = await context.bindings.DB.prepare(
        "SELECT 1 AS active FROM social_connections INNER JOIN workspaces ON workspaces.id = social_connections.workspace_id INNER JOIN users ON users.id = social_connections.connected_by_user_id WHERE social_connections.provider = 'tiktok' AND social_connections.remote_account_id = ? AND social_connections.status IN ('connected', 'limited') AND (social_connections.last_error_code IS NULL OR (social_connections.last_error_code <> 'account_deletion_revoke_completed' AND ((social_connections.last_error_code NOT LIKE 'disconnecting:%' AND social_connections.last_error_code NOT LIKE 'account_deletion_revoke_started:%') OR social_connections.updated_at < ?))) AND workspaces.status = 'active' AND users.status = 'active' LIMIT 1"
      )
        .bind(discoveredRemoteAccountId, staleDisconnectBefore)
        .first<{ active: number }>();
      if (activeGrant !== null) {
        throw failure;
      }
    }
    return await revokeAfterFailure(
      context.bindings,
      "tiktok",
      grantCredentials,
      failure
    );
  }
};

export const exchangeAndDiscover = async (
  platform: Platform,
  context: DiscoveryContext
): Promise<number> => {
  if (platform === "facebook") {
    return await connectFacebook(context);
  }
  if (platform === "instagram") {
    return await connectInstagram(context);
  }
  if (platform === "youtube") {
    return await connectYoutube(context);
  }

  return await connectTiktok(context);
};
