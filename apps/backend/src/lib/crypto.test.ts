import { describe, expect, it } from "vitest";

import {
  decryptJson,
  encryptJson,
  hashPassword,
  hmacSha256Hex,
  verifyPassword
} from "./crypto";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("credential cryptography", () => {
  it("round-trips an authenticated JSON envelope", async () => {
    const encrypted = await encryptJson(
      { accessToken: "test-token", refreshToken: "test-refresh" },
      encryptionKey
    );

    expect(encrypted).not.toContain("test-token");
    await expect(
      decryptJson<{ accessToken: string; refreshToken: string }>(
        encrypted,
        encryptionKey
      )
    ).resolves.toEqual({
      accessToken: "test-token",
      refreshToken: "test-refresh"
    });
  });

  it("rejects a modified ciphertext", async () => {
    const encrypted = await encryptJson({ value: "private" }, encryptionKey);
    const replacement = encrypted.endsWith("A") ? "B" : "A";

    await expect(
      decryptJson(encrypted.slice(0, -1) + replacement, encryptionKey)
    ).rejects.toThrow();
  });

  it("matches the standard HMAC-SHA256 test vector", async () => {
    await expect(
      hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog")
    ).resolves.toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
    );
  });

  it("verifies only the original password", async () => {
    const encoded = await hashPassword("a correct horse battery staple");

    await expect(
      verifyPassword("a correct horse battery staple", encoded)
    ).resolves.toBe(true);
    await expect(verifyPassword("the wrong password", encoded)).resolves.toBe(
      false
    );
  });
});
