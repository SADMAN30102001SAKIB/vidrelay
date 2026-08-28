import type { Platform } from "@vidrelay/shared";
import { z } from "zod";

import type { Bindings } from "../env";
import { providerJson } from "./http";

export type MetaPlatform = Extract<Platform, "facebook" | "instagram">;

export const facebookScopes = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts"
] as const;

export const instagramScopes = [
  "instagram_business_basic",
  "instagram_business_content_publish"
] as const;

const permissionsSchema = z.object({
  data: z.array(
    z.object({
      permission: z.string().min(1),
      status: z.string().min(1)
    })
  )
});

export const fetchMetaGrantedScopes = async (
  bindings: Bindings,
  provider: MetaPlatform,
  accessToken: string
): Promise<string[]> => {
  const host =
    provider === "instagram" ? "graph.instagram.com" : "graph.facebook.com";
  const response = permissionsSchema.parse(
    await providerJson<unknown>(
      "https://" + host + "/" + bindings.META_GRAPH_VERSION + "/me/permissions",
      {
        headers: { Authorization: "Bearer " + accessToken },
        method: "GET"
      },
      { operation: provider + "_permission_check" }
    )
  );

  return response.data
    .filter(permission => permission.status === "granted")
    .map(permission => permission.permission);
};

export const hasEveryScope = (
  grantedScopes: readonly string[],
  requiredScopes: readonly string[]
): boolean => {
  const granted = new Set(grantedScopes);
  return requiredScopes.every(scope => granted.has(scope));
};
