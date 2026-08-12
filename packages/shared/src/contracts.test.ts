import { describe, expect, it } from "vitest";

import {
  apiErrorSchema,
  createPostSchema,
  tiktokSettingsSchema,
  uploadCreateSchema
} from "./contracts";
import { commonMediaProfile } from "./platforms";

describe("shared contracts", () => {
  it("accepts the API error envelope emitted by the backend", () => {
    const result = apiErrorSchema.safeParse({
      error: { code: "invalid_request", message: "The request is invalid." },
      requestId: "request-1"
    });

    expect(result.success).toBe(true);
  });

  it("rejects videos beyond the common profile size", () => {
    const result = uploadCreateSchema.safeParse({
      filename: "too-large.mp4",
      mimeType: "video/mp4",
      size: commonMediaProfile.maxBytes + 1
    });

    expect(result.success).toBe(false);
  });

  it("requires explicit TikTok consent", () => {
    const result = tiktokSettingsSchema.safeParse({
      brandedContent: false,
      consentConfirmed: false,
      disableComment: true,
      disableDuet: true,
      disableStitch: true,
      isAiGenerated: false,
      ownBrand: false,
      privacyLevel: "SELF_ONLY",
      title: "A test"
    });

    expect(result.success).toBe(false);
  });

  it("rejects empty destination submissions", () => {
    const result = createPostSchema.safeParse({
      destinations: [],
      idempotencyKey: "d87fd631-1306-4bb1-8394-49cfbcb46fe2",
      rightsConfirmed: true,
      sharedCaption: "",
      uploadId: "upload-1"
    });

    expect(result.success).toBe(false);
  });
});
