import { describe, expect, it } from "vitest";

import type { Bindings } from "../env";
import { presignR2UploadPart } from "./r2-s3";

const bindings = {
  R2_ACCESS_KEY_ID: "test-access",
  R2_ACCOUNT_ID: "abc123",
  R2_BUCKET_NAME: "vidrelay-media",
  R2_SECRET_ACCESS_KEY: "test-secret"
} as Bindings;

describe("R2 SigV4 presigning", () => {
  it("creates a deterministic, narrowly scoped upload-part URL", async () => {
    const url = new URL(
      await presignR2UploadPart(bindings, {
        contentLength: 16 * 1024 * 1024,
        expiresSeconds: 300,
        key: "workspaces/ws 1/uploads/video.mp4",
        multipartUploadId: "upload+/=",
        now: new Date("2026-08-08T01:02:03.000Z"),
        partNumber: 7
      })
    );

    expect(url.host).toBe("abc123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(
      "/vidrelay-media/workspaces/ws%201/uploads/video.mp4"
    );
    expect(url.searchParams.get("partNumber")).toBe("7");
    expect(url.searchParams.get("uploadId")).toBe("upload+/=");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host"
    );
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      "ee5806ee40cffe51e902036498b615cd401d6754920df9c6538a285957166e80"
    );
  });
});
