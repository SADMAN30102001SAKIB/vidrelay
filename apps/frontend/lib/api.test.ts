import { afterEach, describe, expect, it, vi } from "vitest";

import { apiRequest, resolveApiUrl, sessionExpiredEvent } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveApiUrl", () => {
  it("normalizes an explicitly configured URL", () => {
    expect(resolveApiUrl(" https://api.example.com ", "production")).toBe(
      "https://api.example.com"
    );
  });

  it("uses localhost outside production", () => {
    expect(resolveApiUrl(undefined, "development")).toBe(
      "http://localhost:4000"
    );
  });

  it("allows explicit HTTP loopback only for the local preview command", () => {
    expect(resolveApiUrl("http://localhost:4000", "production", true)).toBe(
      "http://localhost:4000"
    );
    expect(() =>
      resolveApiUrl("http://localhost:4000", "production")
    ).toThrow();
  });

  it("rejects a production build without an API URL", () => {
    expect(() => resolveApiUrl("  ", "production")).toThrow(
      "NEXT_PUBLIC_API_URL must be an exact HTTPS origin"
    );
  });

  it.each([
    "http://api.example.com",
    "https://api.example.com/",
    "https://api.example.com/path",
    "https://user:secret@api.example.com",
    "https://api.example.com?tenant=one",
    "REPLACE_WITH_EXACT_API_ORIGIN"
  ])("rejects a noncanonical production API origin: %s", value => {
    expect(() => resolveApiUrl(value, "production")).toThrow();
  });
});

describe("apiRequest", () => {
  it("signals session expiration when authentication is required", async () => {
    const browser = new EventTarget();
    const expired = vi.fn();
    browser.addEventListener(sessionExpiredEvent, expired);
    vi.stubGlobal("window", browser);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "authentication_required",
              message: "Sign in again."
            }
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

  it("keeps the session for a rejected password confirmation", async () => {
    const browser = new EventTarget();
    const expired = vi.fn();
    browser.addEventListener(sessionExpiredEvent, expired);
    vi.stubGlobal("window", browser);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "invalid_password",
              message: "The current password is incorrect."
            }
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 401
          }
        )
      )
    );

    await expect(apiRequest("/api/account/deletion")).rejects.toMatchObject({
      code: "invalid_password",
      status: 401
    });
    expect(expired).not.toHaveBeenCalled();
  });
});
