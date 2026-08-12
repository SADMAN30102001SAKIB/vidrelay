import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apiRequest,
  resolveApiUrl,
  sessionExpiredEvent
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveApiUrl", () => {
  it("normalizes an explicitly configured URL", () => {
    expect(resolveApiUrl(" https://api.example.com/ ", "production")).toBe(
      "https://api.example.com"
    );
  });

  it("uses localhost outside production", () => {
    expect(resolveApiUrl(undefined, "development")).toBe(
      "http://localhost:4000"
    );
  });

  it("rejects a production build without an API URL", () => {
    expect(() => resolveApiUrl("  ", "production")).toThrow(
      "NEXT_PUBLIC_API_URL must be set"
    );
  });
});

describe("apiRequest", () => {
  it("signals session expiration for every 401 response", async () => {
    const browser = new EventTarget();
    const expired = vi.fn();
    browser.addEventListener(sessionExpiredEvent, expired);
    vi.stubGlobal("window", browser);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "unauthorized", message: "Sign in again." }
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 401
          }
        )
      )
    );

    await expect(apiRequest("/api/auth/me")).rejects.toMatchObject({
      status: 401
    });
    expect(expired).toHaveBeenCalledOnce();
  });
});
