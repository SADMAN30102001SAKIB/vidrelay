import type { Bindings } from "../env";
import type { Platform } from "@vidrelay/shared";
import { z } from "zod";

import type { socialConnections } from "../db/schema";
import { requireSecret } from "../env";
import { ProviderError } from "../lib/errors";
import type { StoredCredentials } from "./credentials";
import { formBody, providerJson } from "./http";

const tiktokRefreshSchema = z.object({
  access_token: z.string().min(1)
});

export const revokeProviderGrant = async (
  bindings: Bindings,
  provider: Platform,
  credentials: StoredCredentials
): Promise<void> => {
  try {
    if (provider === "youtube") {
      await providerJson<unknown>(
        "https://oauth2.googleapis.com/revoke",
        {
          body: formBody({
            token: credentials.refreshToken ?? credentials.accessToken
          }),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST"
        },
        { operation: "youtube_revoke" }
      );
      return;
    }

    if (provider === "tiktok") {
      const clientKey = requireSecret(
        bindings.TIKTOK_CLIENT_KEY,
        "TIKTOK_CLIENT_KEY"
      );
      const clientSecret = requireSecret(
        bindings.TIKTOK_CLIENT_SECRET,
        "TIKTOK_CLIENT_SECRET"
      );
      let accessToken = credentials.accessToken;
      if (
        credentials.expiresAt !== null &&
        credentials.expiresAt <= Date.now()
      ) {
        if (credentials.refreshToken === null) {
          throw new ProviderError({
            code: "tiktok_refresh_token_missing",
            message:
              "The expired TikTok authorization cannot be refreshed for revocation."
          });
        }
        const refreshed = tiktokRefreshSchema.parse(
          await providerJson<unknown>(
            "https://open.tiktokapis.com/v2/oauth/token/",
            {
              body: formBody({
                client_key: clientKey,
                client_secret: clientSecret,
                grant_type: "refresh_token",
                refresh_token: credentials.refreshToken
              }),
              headers: {
                "Content-Type": "application/x-www-form-urlencoded"
              },
              method: "POST"
            },
            { operation: "tiktok_token_refresh_for_revoke" }
          )
        );
        accessToken = refreshed.access_token;
      }
      await providerJson<unknown>(
        "https://open.tiktokapis.com/v2/oauth/revoke/",
        {
          body: formBody({
            client_key: clientKey,
            client_secret: clientSecret,
            token: accessToken
          }),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST"
        },
        { operation: "tiktok_revoke" }
      );
      return;
    }

    const host =
      provider === "instagram" ? "graph.instagram.com" : "graph.facebook.com";
    await providerJson<unknown>(
      "https://" + host + "/" + bindings.META_GRAPH_VERSION + "/me/permissions",
      {
        headers: {
          Authorization:
            "Bearer " + (credentials.userAccessToken ?? credentials.accessToken)
        },
        method: "DELETE"
      },
      { operation: provider + "_revoke" }
    );
  } catch (error) {
    if (
      provider !== "tiktok" &&
      error instanceof ProviderError &&
      (error.providerStatus === 400 || error.providerStatus === 401)
    ) {
      return;
    }
    throw error;
  }
};

export const revokeProviderCredentials = async (
  bindings: Bindings,
  row: typeof socialConnections.$inferSelect,
  credentials: StoredCredentials
): Promise<void> =>
  await revokeProviderGrant(bindings, row.provider, credentials);
