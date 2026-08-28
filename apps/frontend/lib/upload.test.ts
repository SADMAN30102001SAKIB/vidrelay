import { afterEach, describe, expect, it, vi } from "vitest";

import { fileFingerprint, putUploadPart } from "./upload";

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

  it("aborts and rejects an in-flight request when cancellation happens", async () => {
    class StubXMLHttpRequest extends EventTarget {
      readonly abort = vi.fn(() => this.dispatchEvent(new Event("abort")));
      readonly getResponseHeader = vi.fn(() => null);
      readonly open = vi.fn();
      readonly responseText = "";
      readonly send = vi.fn();
      readonly setRequestHeader = vi.fn();
      readonly status = 0;
      readonly upload = new EventTarget();
      withCredentials = false;
    }
    const request = new StubXMLHttpRequest();
    const requestConstructor = vi.fn(function createRequest() {
      return request;
    });
    vi.stubGlobal("XMLHttpRequest", requestConstructor);
    const controller = new AbortController();

    const result = putUploadPart({
      blob: new Blob(["part"]),
      mode: "direct",
      onProgress: vi.fn(),
      signal: controller.signal,
      url: "https://storage.example.com/upload-part"
    });
    expect(requestConstructor).toHaveBeenCalledOnce();
    expect(request.send).toHaveBeenCalledOnce();

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(request.abort).toHaveBeenCalledOnce();
  });
});

describe("fileFingerprint", () => {
  it("distinguishes files that have identical browser metadata", async () => {
    const options = { lastModified: 1_700_000_000_000, type: "video/mp4" };
    const first = new File(["aaaa"], "clip.mp4", options);
    const second = new File(["bbbb"], "clip.mp4", options);

    await expect(fileFingerprint(first)).resolves.not.toBe(
      await fileFingerprint(second)
    );
  });
});
