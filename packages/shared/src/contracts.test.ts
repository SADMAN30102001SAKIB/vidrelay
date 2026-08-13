import { describe, expect, it } from "vitest";

import {
  abandonDestinationSchema,
  apiErrorSchema,
  createPostSchema,
  provisionCustomerSchema,
  resolveDestinationSchema,
  tiktokSettingsSchema,
  uploadCreateSchema,
  uploadSchema
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

  it("exposes whether upload storage cleanup is complete", () => {
    const result = uploadSchema.safeParse({
      audioCodec: "aac",
      createdAt: 1,
      durationMs: 1000,
      filename: "video.mp4",
      fps: 30,
      height: 1920,
      id: "upload-1",
      mimeType: "video/mp4",
      size: 1024,
      storageDeletedAt: null,
      status: "aborted",
      validation: { errors: [], warnings: [] },
      videoCodec: "h264",
      width: 1080
    });

    expect(result.success).toBe(true);
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

  it("requires explicit acknowledgement before abandoning a destination", () => {
    expect(
      abandonDestinationSchema.safeParse({
        acknowledgement: "abandon_destination"
      }).success
    ).toBe(true);
    expect(
      abandonDestinationSchema.safeParse({
        acknowledgement: "retry_destination"
      }).success
    ).toBe(false);
  });

  it("requires operator acknowledgement for customer provisioning", () => {
    const account = {
      email: "customer@example.com",
      name: "Customer Owner",
      password: "correct horse battery staple",
      timezone: "Asia/Dhaka",
      workspaceName: "Customer Workspace"
    };

    expect(
      provisionCustomerSchema.safeParse({
        ...account,
        acknowledgement: "provision_customer"
      }).success
    ).toBe(true);
    expect(provisionCustomerSchema.safeParse(account).success).toBe(false);
  });

  it("accepts only HTTPS manual provider evidence", () => {
    expect(
      resolveDestinationSchema.safeParse({
        acknowledgement: "I CHECKED THE PROVIDER",
        outcome: "published",
        providerUrl: "https://provider.example/post/1"
      }).success
    ).toBe(true);
    expect(
      resolveDestinationSchema.safeParse({
        acknowledgement: "I CHECKED THE PROVIDER",
        outcome: "published",
        providerUrl: "javascript:alert(1)"
      }).success
    ).toBe(false);
    expect(
      resolveDestinationSchema.safeParse({
        acknowledgement: "I CHECKED THE PROVIDER",
        outcome: "published",
        providerUrl: "invalid_value"
      }).success
    ).toBe(false);
  });
});
