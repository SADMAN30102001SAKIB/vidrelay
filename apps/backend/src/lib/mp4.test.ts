import { describe, expect, it } from "vitest";

import { inspectMp4 } from "./mp4";

const box = (type: string, payload = new Uint8Array()): Uint8Array => {
  const bytes = new Uint8Array(8 + payload.byteLength);
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength);
  for (let index = 0; index < 4; index += 1) {
    bytes[4 + index] = type.charCodeAt(index);
  }
  bytes.set(payload, 8);
  return bytes;
};

const bucketFor = (bytes: Uint8Array): R2Bucket =>
  ({
    get: (
      _key: string,
      options?: { range?: { length: number; offset: number } }
    ) => {
      const offset = options?.range?.offset ?? 0;
      const length = options?.range?.length ?? bytes.byteLength;
      const selected = bytes.slice(offset, offset + length);
      return Promise.resolve({
        arrayBuffer: () => Promise.resolve(selected.buffer)
      });
    }
  }) as unknown as R2Bucket;

describe("MP4 inspection", () => {
  it("rejects a file with no movie metadata box", async () => {
    const bytes = box("ftyp");
    const result = await inspectMp4(bucketFor(bytes), "test.mp4", bytes.byteLength);

    expect(result.errors).toContain(
      "The file is not a readable ISO Base Media (MP4) container."
    );
  });

  it("does not accept an empty movie metadata box as a compatible video", async () => {
    const ftyp = box("ftyp");
    const moov = box("moov");
    const bytes = new Uint8Array(ftyp.byteLength + moov.byteLength);
    bytes.set(ftyp);
    bytes.set(moov, ftyp.byteLength);

    const result = await inspectMp4(bucketFor(bytes), "test.mp4", bytes.byteLength);

    expect(result.errors).toContain("Video must use the H.264 codec.");
    expect(result.errors).toContain("Audio must use the AAC codec.");
    expect(result.errors).toContain("Video dimensions could not be verified.");
    expect(result.errors).toContain("Video duration could not be verified.");
  });
});
