import type { Platform } from "@vidrelay/shared";
import { z } from "zod";

import type { Bindings } from "../env";
import type { Database } from "../db/client";
import { requireSecret } from "../env";
import { sha256Base64Url } from "../lib/crypto";
import { formBody, providerJson } from "../platforms/http";
import {
  upsertConnection,
  type StoredCredentials
} from "../platforms/credentials";

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

const redirectUri = (bindings: Bindings, platform: Platform): string =>
  new URL("/api/oauth/" + platform + "/callback", bindings.PUBLIC_API_ORIGIN).toString();

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
const youtubeScopes = ["https://www.googleapis.com/auth/youtube.upload"] as const;
const tiktokScopes = ["user.info.basic", "video.publish"] as const;

export const createAuthorizationRequest = async (
  bindings: Bindings,
  platform: Platform,
  state: string
): Promise<AuthorizationRequest> => {
  const callback = redirectUri(bindings, platform);

  if (platform === "facebook") {
    const url = new URL(
      "https://www.facebook.com/" + bindings.META_GRAPH_VERSION + "/dialog/oauth"
    );
    url.searchParams.set("client_id", requireSecret(bindings.META_APP_ID, "META_APP_ID"));
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
    url.searchParams.set("client_id", requireSecret(bindings.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"));
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

const connectFacebook = async (context: DiscoveryContext): Promise<number> => {
  const appId = requireSecret(context.bindings.META_APP_ID, "META_APP_ID");
  const appSecret = requireSecret(context.bindings.META_APP_SECRET, "META_APP_SECRET");
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

  const shortToken = tokenSchema.parse(
    await providerJson<unknown>(exchangeUrl.toString(), { method: "GET" }, {
      operation: "facebook_token_exchange"
    })
  );
  const longUrl = new URL(exchangeUrl.origin + exchangeUrl.pathname);
  longUrl.searchParams.set("client_id", appId);
  longUrl.searchParams.set("client_secret", appSecret);
  longUrl.searchParams.set("fb_exchange_token", shortToken.access_token);
  longUrl.searchParams.set("grant_type", "fb_exchange_token");
  const longToken = tokenSchema.parse(
    await providerJson<unknown>(longUrl.toString(), { method: "GET" }, {
      operation: "facebook_long_token_exchange"
    })
  );

  const pagesSchema = z.object({
    data: z.array(
      z.object({
        access_token: z.string().min(1),
        id: z.string().min(1),
        name: z.string().min(1),
        picture: z
          .object({ data: z.object({ url: z.string().url().optional() }).optional() })
          .optional(),
        tasks: z.array(z.string()).optional()
      })
    )
  });
  const pagesUrl = new URL(
    "https://graph.facebook.com/" + context.bindings.META_GRAPH_VERSION + "/me/accounts"
  );
  pagesUrl.searchParams.set("fields", "id,name,access_token,tasks,picture{url}");
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
    longToken.expires_in === undefined ? null : Date.now() + longToken.expires_in * 1000;
  for (const page of pages.data) {
    const tasks = page.tasks ?? [];
    const canPublish = tasks.includes("CREATE_CONTENT") || tasks.includes("MANAGE");
    await upsertConnection(context.db, context.bindings, {
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
      metadata: { tasks },
      platform: "facebook",
      remoteAccountId: page.id,
      scopes: [...facebookScopes],
      status: canPublish ? "connected" : "limited",
      workspaceId: context.workspaceId
    });
  }

  return pages.data.length;
};

const connectInstagram = async (context: DiscoveryContext): Promise<number> => {
  const appId = requireSecret(context.bindings.INSTAGRAM_APP_ID, "INSTAGRAM_APP_ID");
  const appSecret = requireSecret(
    context.bindings.INSTAGRAM_APP_SECRET,
    "INSTAGRAM_APP_SECRET"
  );
  const shortToken = z
    .object({
      access_token: z.string().min(1),
      permissions: z.string().optional(),
      user_id: z.union([z.string(), z.number()]).transform(String)
    })
    .parse(
      await providerJson<unknown>(
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
      )
    );

  const longUrl = new URL("https://graph.instagram.com/access_token");
  longUrl.searchParams.set("access_token", shortToken.access_token);
  longUrl.searchParams.set("client_secret", appSecret);
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  const longToken = tokenSchema.parse(
    await providerJson<unknown>(longUrl.toString(), { method: "GET" }, {
      operation: "instagram_long_token_exchange"
    })
  );
  const profileUrl = new URL(
    "https://graph.instagram.com/" + context.bindings.META_GRAPH_VERSION + "/me"
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
  const expiresAt =
    longToken.expires_in === undefined ? null : Date.now() + longToken.expires_in * 1000;

  await upsertConnection(context.db, context.bindings, {
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
    scopes: shortToken.permissions?.split(",").filter(Boolean) ?? [...instagramScopes],
    workspaceId: context.workspaceId
  });

  return 1;
};

const connectYoutube = async (context: DiscoveryContext): Promise<number> => {
  const token = tokenSchema.parse(
    await providerJson<unknown>(
      "https://oauth2.googleapis.com/token",
      {
        body: formBody({
          client_id: requireSecret(context.bindings.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
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
    )
  );
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
    token.expires_in === undefined ? null : Date.now() + token.expires_in * 1000;

  for (const channel of channels.items) {
    await upsertConnection(context.db, context.bindings, {
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
      platform: "youtube",
      remoteAccountId: channel.id,
      scopes: token.scope?.split(" ").filter(Boolean) ?? [...youtubeScopes],
      workspaceId: context.workspaceId
    });
  }

  return channels.items.length;
};

const connectTiktok = async (context: DiscoveryContext): Promise<number> => {
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
    .parse(
      await providerJson<unknown>(
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
      )
    );
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
  const expiresAt = Date.now() + token.expires_in * 1000;
  await upsertConnection(context.db, context.bindings, {
    avatarUrl: user.avatar_url ?? null,
    connectedByUserId: context.userId,
    credentials: baseCredential({
      accessToken: token.access_token,
      expiresAt,
      refreshExpiresAt: Date.now() + token.refresh_expires_in * 1000,
      refreshToken: token.refresh_token,
      tokenType: token.token_type
    }),
    displayName: user.display_name ?? "TikTok creator",
    expiresAt,
    metadata: { unionId: user.union_id ?? null },
    platform: "tiktok",
    remoteAccountId: user.open_id ?? token.open_id,
    scopes: token.scope.split(",").filter(Boolean),
    workspaceId: context.workspaceId
  });

  return 1;
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
