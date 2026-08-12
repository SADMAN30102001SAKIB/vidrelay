import { commonMediaProfile } from "@vidrelay/shared";

interface Box {
  dataStart: number;
  end: number;
  start: number;
  type: string;
}

export interface MediaInspection {
  audioCodec: string | null;
  durationMs: number | null;
  errors: string[];
  fps: number | null;
  height: number | null;
  videoCodec: string | null;
  warnings: string[];
  width: number | null;
}

const maximumMoovBytes = 16 * 1024 * 1024;
const maximumTopLevelBoxes = 256;

const typeAt = (data: Uint8Array, offset: number): string =>
  String.fromCharCode(
    data[offset] ?? 0,
    data[offset + 1] ?? 0,
    data[offset + 2] ?? 0,
    data[offset + 3] ?? 0
  );

const uint32 = (data: Uint8Array, offset: number): number =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset);

const uint64 = (data: Uint8Array, offset: number): number => {
  const high = uint32(data, offset);
  const low = uint32(data, offset + 4);
  const value = high * 2 ** 32 + low;
  return Number.isSafeInteger(value) ? value : 0;
};

const boxAt = (data: Uint8Array, start: number, limit: number): Box | null => {
  if (start < 0 || start + 8 > limit || limit > data.byteLength) {
    return null;
  }

  const size32 = uint32(data, start);
  const type = typeAt(data, start + 4);
  let size = size32;
  let headerSize = 8;
  if (size32 === 1) {
    if (start + 16 > limit) {
      return null;
    }
    size = uint64(data, start + 8);
    headerSize = 16;
  } else if (size32 === 0) {
    size = limit - start;
  }

  if (size < headerSize || start + size > limit || !Number.isSafeInteger(size)) {
    return null;
  }

  return {
    dataStart: start + headerSize,
    end: start + size,
    start,
    type
  };
};

const children = (data: Uint8Array, parent: Box): Box[] => {
  const result: Box[] = [];
  let offset = parent.dataStart;
  while (offset + 8 <= parent.end && result.length < 10_000) {
    const box = boxAt(data, offset, parent.end);
    if (box === null) {
      break;
    }
    result.push(box);
    offset = box.end;
  }
  return result;
};

const child = (data: Uint8Array, parent: Box, type: string): Box | null =>
  children(data, parent).find(box => box.type === type) ?? null;

const mediaTime = (
  data: Uint8Array,
  box: Box
): { duration: number; timescale: number } | null => {
  const version = data[box.dataStart];
  if (version === 0 && box.dataStart + 20 <= box.end) {
    return {
      duration: uint32(data, box.dataStart + 16),
      timescale: uint32(data, box.dataStart + 12)
    };
  }
  if (version === 1 && box.dataStart + 32 <= box.end) {
    return {
      duration: uint64(data, box.dataStart + 24),
      timescale: uint32(data, box.dataStart + 20)
    };
  }
  return null;
};

const sampleCodec = (data: Uint8Array, stsd: Box): string | null => {
  const entryStart = stsd.dataStart + 8;
  if (entryStart + 8 > stsd.end) {
    return null;
  }
  const type = typeAt(data, entryStart + 4);
  if (type === "avc1" || type === "avc3") {
    return "h264";
  }
  if (type === "mp4a") {
    return "aac";
  }
  return type.trim().length > 0 ? type : null;
};

const averageFps = (
  data: Uint8Array,
  stts: Box,
  timescale: number
): number | null => {
  if (timescale <= 0 || stts.dataStart + 8 > stts.end) {
    return null;
  }
  const entryCount = uint32(data, stts.dataStart + 4);
  let offset = stts.dataStart + 8;
  let sampleCount = 0;
  let totalTicks = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 8 > stts.end) {
      return null;
    }
    const count = uint32(data, offset);
    const delta = uint32(data, offset + 4);
    sampleCount += count;
    totalTicks += count * delta;
    offset += 8;
  }
  if (sampleCount === 0 || totalTicks === 0) {
    return null;
  }
  return (sampleCount * timescale) / totalTicks;
};

const readRange = async (
  bucket: R2Bucket,
  key: string,
  offset: number,
  length: number
): Promise<Uint8Array> => {
  const object = await bucket.get(key, { range: { length, offset } });
  if (object === null) {
    throw new Error("The uploaded object is missing.");
  }
  return new Uint8Array(await object.arrayBuffer());
};

const findTopLevel = async (
  bucket: R2Bucket,
  key: string,
  size: number
): Promise<{ hasFtyp: boolean; moovOffset: number; moovSize: number } | null> => {
  let hasFtyp = false;
  let offset = 0;
  let boxes = 0;
  while (offset + 8 <= size && boxes < maximumTopLevelBoxes) {
    const header = await readRange(bucket, key, offset, Math.min(16, size - offset));
    if (header.byteLength < 8) {
      return null;
    }
    const size32 = uint32(header, 0);
    const type = typeAt(header, 4);
    let boxSize = size32;
    if (size32 === 1) {
      if (header.byteLength < 16) {
        return null;
      }
      boxSize = uint64(header, 8);
    } else if (size32 === 0) {
      boxSize = size - offset;
    }
    if (boxSize < 8 || !Number.isSafeInteger(boxSize) || offset + boxSize > size) {
      return null;
    }

    hasFtyp ||= type === "ftyp";
    if (type === "moov") {
      return { hasFtyp, moovOffset: offset, moovSize: boxSize };
    }
    offset += boxSize;
    boxes += 1;
  }
  return null;
};

export const inspectMp4 = async (
  bucket: R2Bucket,
  key: string,
  size: number
): Promise<MediaInspection> => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const top = await findTopLevel(bucket, key, size);
  if (top === null) {
    return {
      audioCodec: null,
      durationMs: null,
      errors: ["The file is not a readable ISO Base Media (MP4) container."],
      fps: null,
      height: null,
      videoCodec: null,
      warnings,
      width: null
    };
  }
  if (!top.hasFtyp) {
    errors.push("The MP4 file type box is missing.");
  }
  if (top.moovSize > maximumMoovBytes) {
    errors.push("The MP4 metadata is unusually large and cannot be verified safely.");
    return {
      audioCodec: null,
      durationMs: null,
      errors,
      fps: null,
      height: null,
      videoCodec: null,
      warnings,
      width: null
    };
  }

  const data = await readRange(bucket, key, top.moovOffset, top.moovSize);
  const moov = boxAt(data, 0, data.byteLength);
  if (moov?.type !== "moov") {
    errors.push("The MP4 metadata box is malformed.");
    return {
      audioCodec: null,
      durationMs: null,
      errors,
      fps: null,
      height: null,
      videoCodec: null,
      warnings,
      width: null
    };
  }

  const mvhd = child(data, moov, "mvhd");
  const movieTime = mvhd === null ? null : mediaTime(data, mvhd);
  let durationMs =
    movieTime === null || movieTime.timescale === 0
      ? null
      : Math.round((movieTime.duration * 1000) / movieTime.timescale);
  let width: number | null = null;
  let height: number | null = null;
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  let fps: number | null = null;

  for (const track of children(data, moov).filter(box => box.type === "trak")) {
    const tkhd = child(data, track, "tkhd");
    const mdia = child(data, track, "mdia");
    if (mdia === null) {
      continue;
    }
    const hdlr = child(data, mdia, "hdlr");
    const mdhd = child(data, mdia, "mdhd");
    const handler =
      hdlr !== null && hdlr.dataStart + 12 <= hdlr.end
        ? typeAt(data, hdlr.dataStart + 8)
        : "";
    const minf = child(data, mdia, "minf");
    const stbl = minf === null ? null : child(data, minf, "stbl");
    const stsd = stbl === null ? null : child(data, stbl, "stsd");
    const codec = stsd === null ? null : sampleCodec(data, stsd);

    if (handler === "vide") {
      videoCodec = codec;
      if (tkhd !== null && tkhd.end - 8 >= tkhd.dataStart) {
        width = uint32(data, tkhd.end - 8) / 65_536;
        height = uint32(data, tkhd.end - 4) / 65_536;
      }
      const trackTime = mdhd === null ? null : mediaTime(data, mdhd);
      const stts = stbl === null ? null : child(data, stbl, "stts");
      if (trackTime !== null && trackTime.timescale > 0) {
        durationMs ??= Math.round((trackTime.duration * 1000) / trackTime.timescale);
        fps = stts === null ? null : averageFps(data, stts, trackTime.timescale);
      }
    } else if (handler === "soun") {
      audioCodec = codec;
    }
  }

  const roundedWidth = width === null ? null : Math.round(width);
  const roundedHeight = height === null ? null : Math.round(height);
  if (videoCodec !== commonMediaProfile.videoCodec) {
    errors.push("Video must use the H.264 codec.");
  }
  if (audioCodec !== commonMediaProfile.audioCodec) {
    errors.push("Audio must use the AAC codec.");
  }
  if (roundedWidth === null || roundedHeight === null) {
    errors.push("Video dimensions could not be verified.");
  } else {
    if (
      roundedWidth < commonMediaProfile.minWidth ||
      roundedHeight < commonMediaProfile.minHeight
    ) {
      errors.push(
        "Video must be at least " +
          String(commonMediaProfile.minWidth) +
          "×" +
          String(commonMediaProfile.minHeight) +
          "."
      );
    }
    const ratio = roundedWidth / roundedHeight;
    if (Math.abs(ratio - 9 / 16) > 0.005) {
      errors.push("Video must use a vertical 9:16 aspect ratio.");
    }
  }
  if (durationMs === null) {
    errors.push("Video duration could not be verified.");
  } else if (
    durationMs < commonMediaProfile.durationSeconds.min * 1000 ||
    durationMs > commonMediaProfile.durationSeconds.max * 1000
  ) {
    errors.push(
      "Video duration must be between " +
        String(commonMediaProfile.durationSeconds.min) +
        " and " +
        String(commonMediaProfile.durationSeconds.max) +
        " seconds."
    );
  }
  if (fps === null) {
    warnings.push("Frame rate could not be verified from the MP4 timing table.");
  } else if (fps < commonMediaProfile.fps.min || fps > commonMediaProfile.fps.max) {
    errors.push(
      "Frame rate must be between " +
        String(commonMediaProfile.fps.min) +
        " and " +
        String(commonMediaProfile.fps.max) +
        " FPS."
    );
  }

  return {
    audioCodec,
    durationMs,
    errors,
    fps,
    height: roundedHeight,
    videoCodec,
    warnings,
    width: roundedWidth
  };
};
