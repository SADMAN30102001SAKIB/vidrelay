import { describe, expect, it } from "vitest";

import type { Bindings } from "../env";
import type { socialConnections } from "../db/schema";
import { encodeCredentials, type StoredCredentials } from "./credentials";
import { grantRelationship, providerGrantKey } from "./grants";

type ConnectionRow = typeof socialConnections.$inferSelect;

const credentials = (
  refreshToken: string | null,
  accessToken: string,
  userAccessToken: string | null = null
): StoredCredentials => ({
  accessToken,
  expiresAt: null,
  refreshExpiresAt: null,
  refreshToken,
  tokenType: "Bearer",
  userAccessToken
});

const bindings = {
  TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
} as Bindings;

const youtubeConnection = (metadataJson = "{}"): ConnectionRow => ({
  avatarUrl: null,
  connectedByUserId: "user-id",
  createdAt: 1,
  credentialsEncrypted: "encrypted",
  disconnectedAt: null,
  displayName: "Channel",
  expiresAt: null,
  id: crypto.randomUUID(),
  keyVersion: 1,
  lastCheckedAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  metadataJson,
  provider: "youtube",
  refreshLeaseExpiresAt: null,
  refreshLeaseId: null,
  remoteAccountId: crypto.randomUUID(),
  scopesJson: "[]",
  status: "connected",
  updatedAt: 1,
  workspaceId: "workspace-id"
});

const facebookConnection = (
  metadataJson = "{}",
  credentialsEncrypted = "encrypted"
): ConnectionRow => ({
  ...youtubeConnection(metadataJson),
  credentialsEncrypted,
  displayName: "Page",
  provider: "facebook"
});

describe("providerGrantKey", () => {
  it("uses the stable Google subject when it is available", async () => {
    const key = await providerGrantKey(
      {} as Bindings,
      youtubeConnection('{"grantSubject":"google-subject"}'),
      credentials("refresh-token", "access-token")
    );

    expect(key).toBe("youtube:google-subject");
  });

  it("groups legacy YouTube connections by refresh token", async () => {
    const first = await providerGrantKey(
      {} as Bindings,
      youtubeConnection(),
      credentials("shared-refresh-token", "first-access-token")
    );
    const second = await providerGrantKey(
      {} as Bindings,
      youtubeConnection(),
      credentials("shared-refresh-token", "second-access-token")
    );
    const unrelated = await providerGrantKey(
      {} as Bindings,
      youtubeConnection(),
      credentials("different-refresh-token", "first-access-token")
    );

    expect(first).toBe(second);
    expect(first).not.toBe(unrelated);
  });
});

describe("grantRelationship", () => {
  it("uses stable grant identities when both rows have them", async () => {
    const row = facebookConnection('{"grantUserId":"user-1"}');
    const same = facebookConnection('{"grantUserId":"user-1"}');
    const different = facebookConnection('{"grantUserId":"user-2"}');
    const rowCredentials = credentials(null, "page-token", "user-token");

    await expect(
      grantRelationship(bindings, row, same, rowCredentials)
    ).resolves.toBe("shared");
    await expect(
      grantRelationship(bindings, row, different, rowCredentials)
    ).resolves.toBe("different");
  });

  it("treats matching legacy Facebook user tokens as shared", async () => {
    const siblingCredentials = credentials(
      null,
      "other-page-token",
      "shared-user-token"
    );
    const sibling = facebookConnection(
      "{}",
      await encodeCredentials(bindings, siblingCredentials)
    );

    await expect(
      grantRelationship(
        bindings,
        facebookConnection(),
        sibling,
        credentials(null, "page-token", "shared-user-token")
      )
    ).resolves.toBe("shared");
  });

  it("does not treat rotated legacy Facebook tokens as different grants", async () => {
    const sibling = facebookConnection(
      "{}",
      await encodeCredentials(
        bindings,
        credentials(null, "other-page-token", "rotated-user-token")
      )
    );

    await expect(
      grantRelationship(
        bindings,
        facebookConnection('{"grantUserId":"known-user"}'),
        sibling,
        credentials(null, "page-token", "original-user-token")
      )
    ).resolves.toBe("unknown");
  });

  it("treats an unreadable legacy sibling as unknown", async () => {
    await expect(
      grantRelationship(
        bindings,
        facebookConnection(),
        facebookConnection("{}", "not-an-envelope"),
        credentials(null, "page-token", "user-token")
      )
    ).resolves.toBe("unknown");
  });

  it("does not use unequal legacy Google tokens as proof of different users", async () => {
    const sibling = youtubeConnection();
    sibling.credentialsEncrypted = await encodeCredentials(
      bindings,
      credentials("second-refresh-token", "second-access-token")
    );

    await expect(
      grantRelationship(
        bindings,
        youtubeConnection(),
        sibling,
        credentials("first-refresh-token", "first-access-token")
      )
    ).resolves.toBe("unknown");
  });
});
