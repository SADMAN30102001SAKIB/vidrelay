import { describe, expect, it } from "vitest";

import type { Capability } from "@vidrelay/shared";

import {
  cannotPublish,
  privateTikTokAccountEligible,
  resolveTikTokPrivacy
} from "./publishing";

const capability = (mode: Capability["mode"]): Capability => ({
  configured: true,
  message: "Available",
  mode,
  platform: "tiktok"
});

describe("cannotPublish", () => {
  it("allows a development-only provider only in a development service", () => {
    const developmentOnly = capability("development_only");

    expect(cannotPublish(developmentOnly, "development")).toBe(false);
    expect(cannotPublish(developmentOnly, "production")).toBe(true);
    expect(cannotPublish(developmentOnly, undefined)).toBe(true);
  });

  it("blocks unavailable and unconfigured providers", () => {
    expect(cannotPublish(undefined, "development")).toBe(true);
    expect(
      cannotPublish(
        { ...capability("direct_publish"), configured: false },
        "development"
      )
    ).toBe(true);
    expect(cannotPublish(capability("review_pending"), "development")).toBe(
      true
    );
  });
});

describe("TikTok privacy", () => {
  const privateCreator = {
    privacy_level_options: ["SELF_ONLY", "FOLLOWER_OF_CREATOR"] as const
  };

  it("never invents Only me when TikTok did not return that option", () => {
    expect(
      resolveTikTokPrivacy(
        "private_only",
        { privacy_level_options: ["FOLLOWER_OF_CREATOR"] },
        ""
      )
    ).toBeNull();
    expect(resolveTikTokPrivacy("private_only", null, "")).toBeNull();
  });

  it("requires a manual Only me selection in private-only mode", () => {
    expect(resolveTikTokPrivacy("private_only", privateCreator, "")).toBeNull();
    expect(
      resolveTikTokPrivacy("private_only", privateCreator, "SELF_ONLY")
    ).toBe("SELF_ONLY");
    expect(
      resolveTikTokPrivacy(
        "private_only",
        privateCreator,
        "FOLLOWER_OF_CREATOR"
      )
    ).toBeNull();
    expect(privateTikTokAccountEligible(privateCreator)).toBe(true);
  });

  it("rejects a stale selection that is absent from current creator options", () => {
    expect(
      resolveTikTokPrivacy(
        "direct_publish",
        { privacy_level_options: ["SELF_ONLY"] },
        "PUBLIC_TO_EVERYONE"
      )
    ).toBeNull();
  });
});
