import { describe, expect, it } from "vitest";

import type { Bindings } from "../env";

import { getCapability } from "./capabilities";

const bindings = (overrides: Partial<Bindings>): Bindings =>
  ({
    ALLOW_SIGNUPS: "false",
    APP_ENV: "production",
    APP_ORIGINS: "https://app.example.com",
    FACEBOOK_CAPABILITY: "disabled",
    INSTAGRAM_CAPABILITY: "disabled",
    META_GRAPH_VERSION: "v25.0",
    PUBLIC_API_ORIGIN: "https://api.example.com",
    PUBLIC_APP_ORIGIN: "https://app.example.com",
    R2_BUCKET_NAME: "media",
    TIKTOK_CAPABILITY: "disabled",
    UPLOAD_MODE: "direct",
    YOUTUBE_CAPABILITY: "disabled",
    ...overrides
  }) as Bindings;

describe("getCapability", () => {
  it("disables a mode that the selected provider cannot honor", () => {
    expect(
      getCapability(
        bindings({
          FACEBOOK_CAPABILITY: "private_only",
          META_APP_ID: "app-id",
          META_APP_SECRET: "app-secret"
        }),
        "facebook"
      )
    ).toMatchObject({ configured: true, mode: "disabled" });
  });

  it("keeps a provider-specific supported restriction", () => {
    expect(
      getCapability(
        bindings({
          GOOGLE_CLIENT_ID: "client-id",
          GOOGLE_CLIENT_SECRET: "client-secret",
          YOUTUBE_CAPABILITY: "private_only"
        }),
        "youtube"
      )
    ).toMatchObject({ configured: true, mode: "private_only" });
  });
});
