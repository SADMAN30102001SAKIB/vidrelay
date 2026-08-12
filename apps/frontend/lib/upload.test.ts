import { afterEach, describe, expect, it, vi } from "vitest";

import { putUploadPart } from "./upload";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("putUploadPart", () => {
  it("does not start a request when cancellation already happened", async () => {
    const requestConstructor = vi.fn();
    vi.stubGlobal("XMLHttpRequest", requestConstructor);
    const controller = new AbortController();
    controller.abort();

    await expect(
      putUploadPart({
        blob: new Blob(["part"]),
        mode: "direct",
        onProgress: vi.fn(),
        signal: controller.signal,
        url: "https://storage.example.com/upload-part"
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requestConstructor).not.toHaveBeenCalled();
  });
});
