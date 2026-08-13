import { z } from "zod";

import {
  capabilityModeSchema,
  commonMediaProfile,
  commonMediaProfileSchema,
  connectionStatusSchema,
  destinationStatusSchema,
  platformSchema,
  postStatusSchema,
  uploadStatusSchema
} from "./platforms";

const idSchema = z.string().min(1).max(128);
const httpsUrlSchema = z.url().refine(value => /^https:\/\//i.test(value), {
  message: "Use an HTTPS URL."
});

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    message: z.string()
  }),
  requestId: z.string().optional()
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const userSchema = z.object({
  createdAt: z.number().int(),
  email: z.email(),
  id: idSchema,
  name: z.string(),
  role: z.enum(["customer", "operator"]),
  workspace: z.object({
    id: idSchema,
    name: z.string(),
    timezone: z.string()
  })
});
export type User = z.infer<typeof userSchema>;

export const registerSchema = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(2).max(80),
  password: z.string().min(12).max(128),
  timezone: z.string().trim().min(1).max(64),
  workspaceName: z.string().trim().min(2).max(80)
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const provisionCustomerSchema = registerSchema.extend({
  acknowledgement: z.literal("provision_customer")
});
export type ProvisionCustomerInput = z.infer<typeof provisionCustomerSchema>;

export const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(128)
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128)
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(80),
  timezone: z.string().trim().min(1).max(64),
  workspaceName: z.string().trim().min(2).max(80)
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const capabilitySchema = z.object({
  configured: z.boolean(),
  message: z.string(),
  mode: capabilityModeSchema,
  platform: platformSchema
});
export type Capability = z.infer<typeof capabilitySchema>;

export const publicConfigSchema = z.object({
  capabilities: z.array(capabilitySchema),
  environment: z.enum(["development", "production"]),
  mediaProfile: commonMediaProfileSchema,
  productName: z.string(),
  signupsEnabled: z.boolean()
});
export type PublicConfig = z.infer<typeof publicConfigSchema>;

export const connectionSchema = z.object({
  avatarUrl: z.url().nullable(),
  displayName: z.string(),
  expiresAt: z.number().int().nullable(),
  id: idSchema,
  lastCheckedAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  platform: platformSchema,
  remoteAccountId: z.string(),
  status: connectionStatusSchema
});
export type Connection = z.infer<typeof connectionSchema>;

export const uploadCreateSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.literal("video/mp4"),
  size: z.number().int().positive().max(commonMediaProfile.maxBytes)
});
export type UploadCreateInput = z.infer<typeof uploadCreateSchema>;

export const uploadPartRequestSchema = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(25)
});

export const completedPartSchema = z.object({
  etag: z.string().min(1).max(256),
  partNumber: z.number().int().min(1).max(10_000)
});

export const uploadCompleteSchema = z.object({
  parts: z.array(completedPartSchema).min(1).max(10_000)
});

export const uploadSchema = z.object({
  audioCodec: z.string().nullable(),
  createdAt: z.number().int(),
  durationMs: z.number().int().nullable(),
  filename: z.string(),
  fps: z.number().nullable(),
  height: z.number().int().nullable(),
  id: idSchema,
  mimeType: z.string(),
  size: z.number().int(),
  storageDeletedAt: z.number().int().nullable(),
  status: uploadStatusSchema,
  validation: z.object({
    errors: z.array(z.string()),
    warnings: z.array(z.string())
  }),
  videoCodec: z.string().nullable(),
  width: z.number().int().nullable()
});
export type Upload = z.infer<typeof uploadSchema>;

export const facebookSettingsSchema = z.object({
  description: z.string().max(5000),
  title: z.string().max(255).optional()
});

export const instagramSettingsSchema = z.object({
  caption: z.string().max(2200),
  shareToFeed: z.boolean()
});

export const youtubeSettingsSchema = z.object({
  categoryId: z.string().regex(/^\d+$/),
  containsSyntheticMedia: z.boolean(),
  description: z.string().max(5000),
  madeForKids: z.boolean(),
  privacyStatus: z.enum(["private", "unlisted", "public"]),
  title: z.string().trim().min(1).max(100)
});

export const tiktokSettingsSchema = z.object({
  brandedContent: z.boolean(),
  consentConfirmed: z.literal(true),
  disableComment: z.boolean(),
  disableDuet: z.boolean(),
  disableStitch: z.boolean(),
  isAiGenerated: z.boolean(),
  ownBrand: z.boolean(),
  privacyLevel: z.enum([
    "PUBLIC_TO_EVERYONE",
    "MUTUAL_FOLLOW_FRIENDS",
    "FOLLOWER_OF_CREATOR",
    "SELF_ONLY"
  ]),
  title: z.string().max(2200)
});

export const postDestinationInputSchema = z.discriminatedUnion("platform", [
  z.object({
    connectionId: idSchema,
    platform: z.literal("facebook"),
    settings: facebookSettingsSchema
  }),
  z.object({
    connectionId: idSchema,
    platform: z.literal("instagram"),
    settings: instagramSettingsSchema
  }),
  z.object({
    connectionId: idSchema,
    platform: z.literal("youtube"),
    settings: youtubeSettingsSchema
  }),
  z.object({
    connectionId: idSchema,
    platform: z.literal("tiktok"),
    settings: tiktokSettingsSchema
  })
]);
export type PostDestinationInput = z.infer<typeof postDestinationInputSchema>;

export const createPostSchema = z
  .object({
    destinations: z.array(postDestinationInputSchema).min(1).max(4),
    idempotencyKey: z.string().uuid(),
    rightsConfirmed: z.literal(true),
    sharedCaption: z.string().max(5000),
    uploadId: idSchema
  })
  .superRefine((input, context) => {
    const connectionIds = input.destinations.map(
      destination => destination.connectionId
    );
    if (new Set(connectionIds).size !== connectionIds.length) {
      context.addIssue({
        code: "custom",
        message: "Each destination can only be selected once.",
        path: ["destinations"]
      });
    }
    const selectedPlatforms = input.destinations.map(
      destination => destination.platform
    );
    if (new Set(selectedPlatforms).size !== selectedPlatforms.length) {
      context.addIssue({
        code: "custom",
        message: "Each platform can only be selected once.",
        path: ["destinations"]
      });
    }
  });
export type CreatePostInput = z.infer<typeof createPostSchema>;

export const destinationSchema = z.object({
  attemptNumber: z.number().int(),
  connectionDisplayName: z.string(),
  connectionId: idSchema,
  id: idSchema,
  lastError: z.string().nullable(),
  nextPollAt: z.number().int().nullable(),
  platform: platformSchema,
  providerPostId: z.string().nullable(),
  providerUrl: httpsUrlSchema.nullable(),
  reconciliationMode: z.enum(["automatic", "manual"]).nullable(),
  stage: z.string(),
  status: destinationStatusSchema,
  updatedAt: z.number().int()
});
export type Destination = z.infer<typeof destinationSchema>;

export const postSchema = z.object({
  createdAt: z.number().int(),
  destinations: z.array(destinationSchema),
  id: idSchema,
  sharedCaption: z.string(),
  sourceRemovalEligible: z.boolean(),
  status: postStatusSchema,
  submittedAt: z.number().int().nullable(),
  updatedAt: z.number().int(),
  upload: uploadSchema
});
export type Post = z.infer<typeof postSchema>;

export const cursorPageSchema = <T extends z.ZodType>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable()
  });

export const retryDestinationSchema = z.object({
  acknowledgement: z.literal("retry_destination")
});

export const abandonDestinationSchema = z.object({
  acknowledgement: z.literal("abandon_destination")
});

export const reconcileDestinationSchema = z.object({
  acknowledgement: z.literal("reconcile_destination")
});

export const resolveDestinationSchema = z.discriminatedUnion("outcome", [
  z.object({
    acknowledgement: z.literal("I CHECKED THE PROVIDER"),
    outcome: z.literal("not_published")
  }),
  z.object({
    acknowledgement: z.literal("I CHECKED THE PROVIDER"),
    outcome: z.literal("published"),
    providerPostId: z.string().trim().min(1).max(256).optional(),
    providerUrl: httpsUrlSchema.optional()
  })
]);

export const deleteAccountSchema = z.object({
  confirmation: z.literal("DELETE MY ACCOUNT"),
  password: z.string().min(1).max(128)
});

export const deletionStatusSchema = z.enum([
  "requested",
  "processing",
  "retry_scheduled",
  "manual_review",
  "complete"
]);

export const deletionPhaseSchema = z.enum([
  "queued",
  "provider_cleanup",
  "media_cleanup",
  "account_cleanup",
  "complete"
]);
export type DeletionPhase = z.infer<typeof deletionPhaseSchema>;

export const deletionFailureCodeSchema = z.enum([
  "deletion_interrupted",
  "provider_cleanup_failed",
  "media_cleanup_failed",
  "account_cleanup_failed",
  "deletion_processing_failed",
  "deletion_subject_missing"
]);
export type DeletionFailureCode = z.infer<typeof deletionFailureCodeSchema>;

export const deletionViewSchema = z.object({
  actionRequired: z.enum(["none", "wait", "contact_support"]),
  attemptCount: z.number().int().nonnegative(),
  completedAt: z.number().int().nullable(),
  failureCode: deletionFailureCodeSchema.nullable(),
  id: idSchema,
  nextAttemptAt: z.number().int().nullable(),
  phase: deletionPhaseSchema,
  requestedAt: z.number().int(),
  status: deletionStatusSchema,
  updatedAt: z.number().int()
});
export type DeletionView = z.infer<typeof deletionViewSchema>;

export const retryDeletionSchema = z.object({
  acknowledgement: z.literal("retry_deletion")
});
