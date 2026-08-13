import type { Connection } from "@vidrelay/shared";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";

import type { Bindings } from "../env";
import type { Database } from "../db/client";
import { socialConnections } from "../db/schema";
import { decryptJson, encryptJson } from "../lib/crypto";
import { requireSecret } from "../env";
import { ProviderError } from "../lib/errors";
import { formBody, providerJson } from "./http";

export interface StoredCredentials {
  accessToken: string;
  expiresAt: number | null;
  refreshExpiresAt: number | null;
  refreshToken: string | null;
  tokenType: string | null;
  userAccessToken: string | null;
}

export interface FreshCredentials {
  credentials: StoredCredentials;
  credentialsEncrypted: string;
  lastErrorCode: string | null;
}

const parseObject = (value: string): Record<string, unknown> => {
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

export const decodeCredentials = async (
  bindings: Bindings,
  encrypted: string
): Promise<StoredCredentials> =>
  await decryptJson<StoredCredentials>(
    encrypted,
    requireSecret(bindings.TOKEN_ENCRYPTION_KEY, "TOKEN_ENCRYPTION_KEY")
  );

export const encodeCredentials = async (
  bindings: Bindings,
  credentials: StoredCredentials
): Promise<string> =>
  await encryptJson(
    credentials,
    requireSecret(bindings.TOKEN_ENCRYPTION_KEY, "TOKEN_ENCRYPTION_KEY")
  );

export const toConnection = (
  row: typeof socialConnections.$inferSelect
): Connection => ({
  avatarUrl: row.avatarUrl,
  displayName: row.displayName,
  expiresAt: row.expiresAt,
  id: row.id,
  lastCheckedAt: row.lastCheckedAt,
  lastError: row.lastErrorMessage,
  metadata: parseObject(row.metadataJson),
  platform: row.provider,
  remoteAccountId: row.remoteAccountId,
  status: row.status
});

export const ensureFreshCredentials = async (
  db: Database,
  bindings: Bindings,
  row: typeof socialConnections.$inferSelect
): Promise<FreshCredentials> => {
  if (
    row.lastErrorCode?.startsWith("disconnecting:") ||
    row.lastErrorCode?.startsWith("account_deletion_revoke_started") ||
    row.lastErrorCode === "account_deletion_revoke_completed"
  ) {
    throw new ProviderError({
      code: "connection_removal_in_progress",
      message: "The provider connection is being removed."
    });
  }
  const credentials = await decodeCredentials(
    bindings,
    row.credentialsEncrypted
  );
  if (
    credentials.expiresAt === null ||
    credentials.expiresAt > Date.now() + 5 * 60 * 1000
  ) {
    const [current] = await db
      .select({
        credentialsEncrypted: socialConnections.credentialsEncrypted,
        lastErrorCode: socialConnections.lastErrorCode,
        status: socialConnections.status
      })
      .from(socialConnections)
      .where(eq(socialConnections.id, row.id))
      .limit(1);
    if (
      current?.credentialsEncrypted !== row.credentialsEncrypted ||
      current.status !== row.status ||
      current.lastErrorCode !== row.lastErrorCode
    ) {
      throw new ProviderError({
        code: "credentials_changed",
        message: "The provider credentials changed before they could be used.",
        retryable: true
      });
    }
    return {
      credentials,
      credentialsEncrypted: row.credentialsEncrypted,
      lastErrorCode: row.lastErrorCode
    };
  }

  if (
    row.provider === "facebook" ||
    (row.provider !== "instagram" && credentials.refreshToken === null)
  ) {
    const updated = await db
      .update(socialConnections)
      .set({
        lastErrorCode: "token_expired",
        lastErrorMessage: "Reconnect this account to continue publishing.",
        status: "reauth_required",
        updatedAt: Date.now()
      })
      .where(
        and(
          eq(socialConnections.id, row.id),
          eq(socialConnections.credentialsEncrypted, row.credentialsEncrypted),
          eq(socialConnections.status, row.status),
          row.lastErrorCode === null
            ? isNull(socialConnections.lastErrorCode)
            : eq(socialConnections.lastErrorCode, row.lastErrorCode)
        )
      )
      .returning({ id: socialConnections.id });
    if (updated.length === 0) {
      throw new ProviderError({
        code: "credentials_changed",
        message:
          "The provider credentials changed while expiration was being recorded.",
        retryable: true
      });
    }
    throw new ProviderError({
      code: "reauth_required",
      message: "The provider authorization has expired."
    });
  }

  const leaseId = crypto.randomUUID();
  const leaseStartedAt = Date.now();
  const [claimedLease] = await db
    .update(socialConnections)
    .set({
      refreshLeaseExpiresAt: leaseStartedAt + 2 * 60 * 1000,
      refreshLeaseId: leaseId,
      updatedAt: leaseStartedAt
    })
    .where(
      and(
        eq(socialConnections.id, row.id),
        eq(socialConnections.credentialsEncrypted, row.credentialsEncrypted),
        eq(socialConnections.status, row.status),
        row.lastErrorCode === null
          ? isNull(socialConnections.lastErrorCode)
          : eq(socialConnections.lastErrorCode, row.lastErrorCode),
        or(
          isNull(socialConnections.refreshLeaseExpiresAt),
          lt(socialConnections.refreshLeaseExpiresAt, leaseStartedAt)
        )
      )
    )
    .returning({ id: socialConnections.id });
  if (claimedLease === undefined) {
    throw new ProviderError({
      code: "credentials_refresh_in_progress",
      message: "The provider credentials are already being refreshed.",
      retryable: true
    });
  }

  try {
    let refreshed: StoredCredentials;
    if (row.provider === "youtube") {
      if (credentials.refreshToken === null) {
        throw new ProviderError({
          code: "reauth_required",
          message: "The YouTube refresh token is missing."
        });
      }
      const token = z
        .object({
          access_token: z.string().min(1),
          expires_in: z.number(),
          refresh_token: z.string().optional(),
          scope: z.string().optional(),
          token_type: z.string().optional()
        })
        .parse(
          await providerJson<unknown>(
            "https://oauth2.googleapis.com/token",
            {
              body: formBody({
                client_id: requireSecret(
                  bindings.GOOGLE_CLIENT_ID,
                  "GOOGLE_CLIENT_ID"
                ),
                client_secret: requireSecret(
                  bindings.GOOGLE_CLIENT_SECRET,
                  "GOOGLE_CLIENT_SECRET"
                ),
                grant_type: "refresh_token",
                refresh_token: credentials.refreshToken
              }),
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              method: "POST"
            },
            { operation: "youtube_token_refresh" }
          )
        );
      refreshed = {
        ...credentials,
        accessToken: token.access_token,
        expiresAt: Date.now() + token.expires_in * 1000,
        refreshToken: token.refresh_token ?? credentials.refreshToken,
        tokenType: token.token_type ?? credentials.tokenType
      };
    } else if (row.provider === "instagram") {
      const url = new URL("https://graph.instagram.com/refresh_access_token");
      url.searchParams.set("access_token", credentials.accessToken);
      url.searchParams.set("grant_type", "ig_refresh_token");
      const token = z
        .object({
          access_token: z.string().min(1),
          expires_in: z.number(),
          token_type: z.string().optional()
        })
        .parse(
          await providerJson<unknown>(
            url.toString(),
            { method: "GET" },
            { operation: "instagram_token_refresh" }
          )
        );
      refreshed = {
        ...credentials,
        accessToken: token.access_token,
        expiresAt: Date.now() + token.expires_in * 1000,
        tokenType: token.token_type ?? credentials.tokenType
      };
    } else {
      if (credentials.refreshToken === null) {
        throw new ProviderError({
          code: "reauth_required",
          message: "The TikTok refresh token is missing."
        });
      }
      const token = z
        .object({
          access_token: z.string().min(1),
          expires_in: z.number(),
          refresh_expires_in: z.number(),
          refresh_token: z.string().min(1),
          token_type: z.string().optional()
        })
        .parse(
          await providerJson<unknown>(
            "https://open.tiktokapis.com/v2/oauth/token/",
            {
              body: formBody({
                client_key: requireSecret(
                  bindings.TIKTOK_CLIENT_KEY,
                  "TIKTOK_CLIENT_KEY"
                ),
                client_secret: requireSecret(
                  bindings.TIKTOK_CLIENT_SECRET,
                  "TIKTOK_CLIENT_SECRET"
                ),
                grant_type: "refresh_token",
                refresh_token: credentials.refreshToken
              }),
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              method: "POST"
            },
            { operation: "tiktok_token_refresh" }
          )
        );
      refreshed = {
        ...credentials,
        accessToken: token.access_token,
        expiresAt: Date.now() + token.expires_in * 1000,
        refreshExpiresAt: Date.now() + token.refresh_expires_in * 1000,
        refreshToken: token.refresh_token,
        tokenType: token.token_type ?? credentials.tokenType
      };
    }

    const now = Date.now();
    const credentialsEncrypted = await encodeCredentials(bindings, refreshed);
    const updated = await db
      .update(socialConnections)
      .set({
        credentialsEncrypted,
        expiresAt: refreshed.expiresAt,
        lastCheckedAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
        refreshLeaseExpiresAt: null,
        refreshLeaseId: null,
        status: row.status,
        updatedAt: now
      })
      .where(
        and(
          eq(socialConnections.id, row.id),
          eq(socialConnections.credentialsEncrypted, row.credentialsEncrypted),
          eq(socialConnections.status, row.status),
          row.lastErrorCode === null
            ? isNull(socialConnections.lastErrorCode)
            : eq(socialConnections.lastErrorCode, row.lastErrorCode),
          eq(socialConnections.refreshLeaseId, leaseId)
        )
      )
      .returning({ id: socialConnections.id });
    if (updated.length === 0) {
      throw new ProviderError({
        code: "credentials_changed",
        message:
          "The provider credentials changed while they were being refreshed.",
        retryable: true
      });
    }
    return { credentials: refreshed, credentialsEncrypted, lastErrorCode: null };
  } catch (error) {
    if (error instanceof ProviderError && error.retryable) {
      await db
        .update(socialConnections)
        .set({ refreshLeaseExpiresAt: null, refreshLeaseId: null })
        .where(
          and(
            eq(socialConnections.id, row.id),
            eq(socialConnections.refreshLeaseId, leaseId)
          )
        );
      throw error;
    }
    const [latest] = await db
      .select({
        credentialsEncrypted: socialConnections.credentialsEncrypted,
        refreshLeaseId: socialConnections.refreshLeaseId,
        status: socialConnections.status
      })
      .from(socialConnections)
      .where(eq(socialConnections.id, row.id))
      .limit(1);
    if (
      latest?.credentialsEncrypted !== row.credentialsEncrypted ||
      latest.status !== row.status ||
      latest.refreshLeaseId !== leaseId
    ) {
      throw new ProviderError({
        code: "credentials_changed",
        message:
          "The provider credentials changed while they were being refreshed.",
        retryable: true
      });
    }
    const updated = await db
      .update(socialConnections)
      .set({
        lastErrorCode: "token_refresh_failed",
        lastErrorMessage: "Reconnect this account to continue publishing.",
        refreshLeaseExpiresAt: null,
        refreshLeaseId: null,
        status: "reauth_required",
        updatedAt: Date.now()
      })
      .where(
        and(
          eq(socialConnections.id, row.id),
          eq(socialConnections.credentialsEncrypted, row.credentialsEncrypted),
          eq(socialConnections.status, row.status),
          row.lastErrorCode === null
            ? isNull(socialConnections.lastErrorCode)
            : eq(socialConnections.lastErrorCode, row.lastErrorCode),
          eq(socialConnections.refreshLeaseId, leaseId)
        )
      )
      .returning({ id: socialConnections.id });
    if (updated.length === 0) {
      throw new ProviderError({
        code: "credentials_changed",
        message:
          "The provider credentials changed while they were being refreshed.",
        retryable: true
      });
    }
    throw new ProviderError({
      code: "reauth_required",
      message: "The provider authorization could not be refreshed."
    });
  }
};
