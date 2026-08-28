import { z } from "zod";

export const platforms = [
  "facebook",
  "instagram",
  "youtube",
  "tiktok"
] as const;
export const platformSchema = z.enum(platforms);
export type Platform = z.infer<typeof platformSchema>;

export const firstReleasePlatforms: readonly Platform[] = [
  "youtube",
  "facebook",
  "instagram"
];

export const capabilityModes = [
  "disabled",
  "development_only",
  "review_pending",
  "inbox_only",
  "private_only",
  "direct_publish"
] as const;
export const capabilityModeSchema = z.enum(capabilityModes);
export type CapabilityMode = z.infer<typeof capabilityModeSchema>;

export const connectionStatuses = [
  "connected",
  "reauth_required",
  "limited",
  "disconnected"
] as const;
export const connectionStatusSchema = z.enum(connectionStatuses);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

export const destinationStatuses = [
  "blocked",
  "queued",
  "starting",
  "transferring",
  "processing",
  "publishing",
  "retry_scheduled",
  "published",
  "awaiting_user_action",
  "reauth_required",
  "failed_permanent",
  "reconciliation_required",
  "cancelled",
  "unavailable"
] as const;
export const destinationStatusSchema = z.enum(destinationStatuses);
export type DestinationStatus = z.infer<typeof destinationStatusSchema>;

export const postStatuses = [
  "draft",
  "ready",
  "queued",
  "publishing",
  "partial_success",
  "published",
  "failed",
  "cancelled"
] as const;
export const postStatusSchema = z.enum(postStatuses);
export type PostStatus = z.infer<typeof postStatusSchema>;

export const uploadStatuses = [
  "created",
  "uploading",
  "verifying",
  "ready",
  "rejected",
  "aborted"
] as const;
export const uploadStatusSchema = z.enum(uploadStatuses);
export type UploadStatus = z.infer<typeof uploadStatusSchema>;

export const commonMediaProfile = {
  acceptedMimeTypes: ["video/mp4"],
  audioCodec: "aac",
  audioSampleRateHz: 48_000,
  durationSeconds: { min: 4, max: 60 },
  fps: { min: 23, max: 60 },
  maxBytes: 1_073_741_824,
  maxAudioBitrateBps: 128_000,
  maxVideoBitrateBps: 25_000_000,
  maxWidth: 1920,
  minHeight: 960,
  minWidth: 540,
  name: "Vertical MP4",
  ratio: { height: 16, width: 9 },
  recommendedHeight: 1920,
  recommendedWidth: 1080,
  videoCodec: "h264"
} as const;

export const commonMediaProfileSchema = z.object({
  acceptedMimeTypes: z.array(z.literal("video/mp4")),
  audioCodec: z.literal("aac"),
  audioSampleRateHz: z.literal(48_000),
  durationSeconds: z.object({ min: z.literal(4), max: z.literal(60) }),
  fps: z.object({ min: z.literal(23), max: z.literal(60) }),
  maxBytes: z.literal(1_073_741_824),
  maxAudioBitrateBps: z.literal(128_000),
  maxVideoBitrateBps: z.literal(25_000_000),
  maxWidth: z.literal(1920),
  minHeight: z.literal(960),
  minWidth: z.literal(540),
  name: z.literal("Vertical MP4"),
  ratio: z.object({ height: z.literal(16), width: z.literal(9) }),
  recommendedHeight: z.literal(1920),
  recommendedWidth: z.literal(1080),
  videoCodec: z.literal("h264")
});

export const platformLabels: Record<Platform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  youtube: "YouTube",
  tiktok: "TikTok"
};
