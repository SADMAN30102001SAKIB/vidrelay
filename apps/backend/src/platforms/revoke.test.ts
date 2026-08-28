import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bindings } from "../env";

import type { StoredCredentials } from "./credentials";
import { revokeProviderGrant } from "./revoke";

const bindings = { META_GRAPH_VERSION: "v25.0" } as Bindings;
const credentials: StoredCredentials = {
  accessToken: "access-token",
  expiresAt: null,
  refreshExpiresAt: null,
  refreshToken: "refresh-token",
  tokenType: "Bearer",
  userAccessToken: "user-access-token"
};

const providerErrorResponse = (
  status: number,
  code: string,
  subcode?: string
): Response =>
  new Response(
    JSON.stringify({
      error: {
        code,
        error_subcode: subcode,
        message: "Provider rejected the token."
      }
    }),
    { headers: { "Content-Type": "application/json" }, status }
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("revokeProviderGrant", () => {
  it("accepts a confirmed provider success", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 200 }))
    );

    await expect(
      revokeProviderGrant(bindings, "youtube", credentials)
    ).resolves.toBeUndefined();
  });

  it("marks a lost revocation response as an unknown outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network failure"))
    );

    await expect(
      revokeProviderGrant(bindings, "youtube", credentials)
    ).rejects.toMatchObject({ outcomeUnknown: true, retryable: true });
  });

  it("preserves the provider status when the response body cannot be read", async () => {
    const response = new Response(null, { status: 200 });
    vi.spyOn(response, "text").mockRejectedValue(
      new TypeError("response stream failed")
    );
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));

    await expect(
      revokeProviderGrant(bindings, "youtube", credentials)
    ).rejects.toMatchObject({
      code: "youtube_revoke_response_error",
      outcomeUnknown: true,
      providerStatus: 200,
      retryable: true
    });
  });

  it("classifies provider throttling as a definitive retryable failure", async () => {
    const response = providerErrorResponse(429, "rate_limited");
    response.headers.set("Retry-After", "7");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));

    await expect(
      revokeProviderGrant(bindings, "youtube", credentials)
    ).rejects.toMatchObject({
      outcomeUnknown: false,
      providerCode: "rate_limited",
      providerStatus: 429,
      retryAfterSeconds: 7,
      retryable: true
    });
  });

  it.each(["facebook", "instagram"] as const)(
    "does not mistake an invalid Meta credential for confirmed revocation on %s",
    async provider => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(providerErrorResponse(400, "190"));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        revokeProviderGrant(bindings, provider, credentials)
      ).rejects.toMatchObject({
        providerCode: "190",
        providerStatus: 400
      });
    }
  );

  it("does not accept Meta's invalid-session code as revocation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(providerErrorResponse(401, "102"))
    );

    await expect(
      revokeProviderGrant(bindings, "facebook", credentials)
    ).rejects.toMatchObject({ providerCode: "102", providerStatus: 401 });
  });

  it("does not accept an expired Meta credential as revocation", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(providerErrorResponse(400, "190", "463"))
    );

    await expect(
      revokeProviderGrant(bindings, "facebook", credentials)
    ).rejects.toMatchObject({
      providerCode: "190",
      providerStatus: 400,
      providerSubcode: "463"
    });
  });

  it("does not accept Meta's session code when a subcode needs handling", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(providerErrorResponse(400, "102", "459"))
    );

    await expect(
      revokeProviderGrant(bindings, "facebook", credentials)
    ).rejects.toMatchObject({
      providerCode: "102",
      providerStatus: 400,
      providerSubcode: "459"
    });
  });

  it.each([
    [400, "100"],
    [401, "999"]
  ])("does not accept an unrelated Meta %i response", async (status, code) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(providerErrorResponse(status, code))
    );

    await expect(
      revokeProviderGrant(bindings, "facebook", credentials)
    ).rejects.toMatchObject({ providerCode: code, providerStatus: status });
  });

  it("does not accept Google's HTTP 400 revocation error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(providerErrorResponse(400, "invalid_token"))
    );

    await expect(
      revokeProviderGrant(bindings, "youtube", credentials)
    ).rejects.toMatchObject({
      providerCode: "invalid_token",
      providerStatus: 400
    });
  });
});
