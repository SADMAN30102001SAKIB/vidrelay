import type { Destination, Upload } from "@vidrelay/shared";

import type { publishDestinations, uploads } from "../db/schema";

export const validationFrom = (value: string): Upload["validation"] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (Array.isArray(record.errors) && Array.isArray(record.warnings)) {
        return {
          errors: record.errors.filter(item => typeof item === "string"),
          warnings: record.warnings.filter(item => typeof item === "string")
        };
      }
    }
  } catch {
    return { errors: ["Stored validation data is invalid."], warnings: [] };
  }
  return { errors: [], warnings: [] };
};

export const toUpload = (row: typeof uploads.$inferSelect): Upload => ({
  audioCodec: row.audioCodec,
  createdAt: row.createdAt,
  durationMs: row.durationMs,
  filename: row.filename,
  fps: row.fpsMilli === null ? null : row.fpsMilli / 1000,
  height: row.height,
  id: row.id,
  mimeType: row.mimeType,
  size: row.actualSize ?? row.expectedSize,
  status: row.status,
  validation: validationFrom(row.validationJson),
  videoCodec: row.videoCodec,
  width: row.width
});

export const toDestination = (
  row: typeof publishDestinations.$inferSelect,
  connectionDisplayName: string
): Destination => ({
  attemptNumber: row.attemptNumber,
  connectionDisplayName,
  connectionId: row.connectionId,
  id: row.id,
  lastError: row.lastErrorMessage,
  nextPollAt: row.nextPollAt,
  platform: row.platform,
  providerPostId: row.remotePostId,
  providerUrl: row.remoteUrl,
  stage: row.stage,
  status: row.status,
  updatedAt: row.updatedAt
});
