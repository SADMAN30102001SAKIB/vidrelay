import type { Bindings } from "../env";
import { socialConnections } from "../db/schema";
import { ProviderError } from "../lib/errors";
import type { StoredCredentials } from "./credentials";
import { formBody, providerJson } from "./http";

export const revokeProviderCredentials = async (
  bindings: Bindings,
  row: typeof socialConnections.$inferSelect,
  credentials: StoredCredentials
): Promise<void> => {
  try {
    if (row.provider === "youtube") {
      await providerJson<unknown>(
        "https://oauth2.googleapis.com/revoke",
        {
          body: formBody({ token: credentials.refreshToken ?? credentials.accessToken }),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST"
        },
        { operation: "youtube_revoke" }
      );
      return;
    }

    if (row.provider === "tiktok") {
      await providerJson<unknown>(
        "https://open.tiktokapis.com/v2/oauth/revoke/",
        {
          body: formBody({
            client_key: bindings.TIKTOK_CLIENT_KEY ?? "",
            client_secret: bindings.TIKTOK_CLIENT_SECRET ?? "",
            token: credentials.accessToken
          }),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST"
        },
        { operation: "tiktok_revoke" }
      );
      return;
    }

    const host = row.provider === "instagram" ? "graph.instagram.com" : "graph.facebook.com";
    await providerJson<unknown>(
      "https://" + host + "/" + bindings.META_GRAPH_VERSION + "/me/permissions",
      {
        headers: {
          Authorization:
            "Bearer " + (credentials.userAccessToken ?? credentials.accessToken)
        },
        method: "DELETE"
      },
      { operation: row.provider + "_revoke" }
    );
  } catch (error) {
    if (
      error instanceof ProviderError &&
      (error.providerStatus === 400 || error.providerStatus === 401)
    ) {
      return;
    }
    throw error;
  }
};
