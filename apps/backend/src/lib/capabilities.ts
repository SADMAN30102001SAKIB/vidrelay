import {
  capabilityModeSchema,
  commonMediaProfile,
  platforms,
  type Capability,
  type CapabilityMode,
  type Platform,
  type PublicConfig
} from "@vidrelay/shared";

import type { Bindings } from "../env";

const supportedModes: Record<Platform, ReadonlySet<CapabilityMode>> = {
  facebook: new Set([
    "disabled",
    "development_only",
    "review_pending",
    "direct_publish"
  ]),
  instagram: new Set([
    "disabled",
    "development_only",
    "review_pending",
    "direct_publish"
  ]),
  tiktok: new Set([
    "disabled",
    "development_only",
    "review_pending",
    "inbox_only",
    "private_only",
    "direct_publish"
  ]),
  youtube: new Set([
    "disabled",
    "development_only",
    "review_pending",
    "private_only",
    "direct_publish"
  ])
};

const configuredFor = (bindings: Bindings, platform: Platform): boolean => {
  if (platform === "facebook") {
    return Boolean(bindings.META_APP_ID && bindings.META_APP_SECRET);
  }
  if (platform === "instagram") {
    return Boolean(bindings.INSTAGRAM_APP_ID && bindings.INSTAGRAM_APP_SECRET);
  }
  if (platform === "youtube") {
    return Boolean(bindings.GOOGLE_CLIENT_ID && bindings.GOOGLE_CLIENT_SECRET);
  }

  return Boolean(bindings.TIKTOK_CLIENT_KEY && bindings.TIKTOK_CLIENT_SECRET);
};

const configuredMode = (
  bindings: Bindings,
  platform: Platform
): CapabilityMode => {
  const raw =
    platform === "facebook"
      ? bindings.FACEBOOK_CAPABILITY
      : platform === "instagram"
        ? bindings.INSTAGRAM_CAPABILITY
        : platform === "youtube"
          ? bindings.YOUTUBE_CAPABILITY
          : bindings.TIKTOK_CAPABILITY;
  const parsed = capabilityModeSchema.safeParse(raw);
  return parsed.success && supportedModes[platform].has(parsed.data)
    ? parsed.data
    : "disabled";
};

const capabilityMessage = (
  platform: Platform,
  configured: boolean,
  mode: CapabilityMode
): string => {
  if (!configured) {
    return "Provider credentials have not been configured.";
  }
  if (mode === "development_only") {
    return "Available only to provider app roles and test accounts until review is approved.";
  }
  if (mode === "review_pending") {
    return "The integration is implemented but production access is awaiting provider review.";
  }
  if (mode === "private_only") {
    return platform === "youtube"
      ? "Uploads are restricted to private visibility until the YouTube compliance audit is approved."
      : "TikTok limits unaudited Direct Post clients to private visibility.";
  }
  if (mode === "inbox_only") {
    return "TikTok inbox delivery is not implemented, so publishing is unavailable in this mode.";
  }
  if (mode === "disabled") {
    return "This provider is disabled.";
  }

  return "Direct publishing is available.";
};

export const getCapability = (
  bindings: Bindings,
  platform: Platform
): Capability => {
  const configured = configuredFor(bindings, platform);
  const configuredValue = configuredMode(bindings, platform);
  const mode = configured ? configuredValue : "disabled";

  return {
    configured,
    message: capabilityMessage(platform, configured, mode),
    mode,
    platform
  };
};

export const getPublicConfig = (bindings: Bindings): PublicConfig => ({
  capabilities: platforms.map(platform => getCapability(bindings, platform)),
  environment: bindings.APP_ENV,
  mediaProfile: {
    ...commonMediaProfile,
    acceptedMimeTypes: [...commonMediaProfile.acceptedMimeTypes]
  },
  productName: "VidRelay",
  signupsEnabled: bindings.ALLOW_SIGNUPS === "true"
});
