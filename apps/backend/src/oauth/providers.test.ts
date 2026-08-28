import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bindings } from "../env";

import { createAuthorizationRequest, exchangeAndDiscover } from "./providers";

const youtubeUploadScope = "https://www.googleapis.com/auth/youtube.upload";
const youtubeReadonlyScope = "https://www.googleapis.com/auth/youtube.readonly";
const openidScope = "openid";

const bindings = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  PUBLIC_API_ORIGIN: "https://api.example.com"
} as Bindings;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("YouTube OAuth", () => {
  it("requests upload and read-only access", async () => {
    const request = await createAuthorizationRequest(
      bindings,
      "youtube",
      "state"
    );
    const scopes = new Set(
      new URL(request.url).searchParams.get("scope")?.split(" ")
    );

    expect(scopes).toEqual(
      new Set([openidScope, youtubeUploadScope, youtubeReadonlyScope])
    );
  });

  it.each([
    `${openidScope} ${youtubeUploadScope}`,
    `${openidScope} ${youtubeReadonlyScope}`,
    openidScope
  ])(
    "rejects an incomplete granted scope set before discovery: %s",
    async scope => {
      const prepared = {
        all: vi.fn().mockResolvedValue({ results: [] })
      };
      const scopedBindings = {
        ...bindings,
        DB: { prepare: vi.fn(() => prepared) }
      } as unknown as Bindings;
      const fetchMock = vi.fn<typeof fetch>();
      fetchMock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: "access-token",
              expires_in: 3600,
              refresh_token: "refresh-token",
              scope,
              token_type: "Bearer"
            }),
            { headers: { "Content-Type": "application/json" }, status: 200 }
          )
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ sub: "google-subject" }), {
            headers: { "Content-Type": "application/json" },
            status: 200
          })
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        exchangeAndDiscover("youtube", {
          bindings: scopedBindings,
          code: "authorization-code",
          codeVerifier: "code-verifier",
          db: {} as never,
          userId: "user-id",
          workspaceId: "workspace-id"
        })
      ).rejects.toMatchObject({ code: "youtube_scope_missing" });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        "https://oauth2.googleapis.com/revoke",
        expect.objectContaining({ method: "POST" })
      );
    }
  );

  it("does not revoke a grant whose Google subject cannot be identified", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "access-token",
          expires_in: 3600,
          refresh_token: "refresh-token",
          token_type: "Bearer"
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      exchangeAndDiscover("youtube", {
        bindings,
        code: "authorization-code",
        codeVerifier: "code-verifier",
        db: {} as never,
        userId: "user-id",
        workspaceId: "workspace-id"
      })
    ).rejects.toMatchObject({ code: "youtube_scope_missing" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
