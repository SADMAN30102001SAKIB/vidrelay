import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bindings } from "../env";
import {
  fetchMetaGrantedScopes,
  hasEveryScope,
  instagramScopes
} from "./meta-permissions";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Meta permission checks", () => {
  it("keeps only permissions the provider reports as granted", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { permission: "instagram_business_basic", status: "granted" },
            {
              permission: "instagram_business_content_publish",
              status: "declined"
            }
          ]
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const granted = await fetchMetaGrantedScopes(
      { META_GRAPH_VERSION: "v25.0" } as Bindings,
      "instagram",
      "access-token"
    );

    expect(granted).toEqual(["instagram_business_basic"]);
    expect(hasEveryScope(granted, instagramScopes)).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.instagram.com/v25.0/me/permissions",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("accepts only a complete required scope set", () => {
    expect(hasEveryScope(instagramScopes, instagramScopes)).toBe(true);
    expect(hasEveryScope(["instagram_business_basic"], instagramScopes)).toBe(
      false
    );
  });
});
