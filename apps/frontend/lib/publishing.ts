import type {
  Capability,
  CapabilityMode,
  PublicConfig
} from "@vidrelay/shared";

export type TikTokPrivacy =
  | ""
  | "FOLLOWER_OF_CREATOR"
  | "MUTUAL_FOLLOW_FRIENDS"
  | "PUBLIC_TO_EVERYONE"
  | "SELF_ONLY";

export type TikTokPrivacyOption = Exclude<TikTokPrivacy, "">;

interface TikTokCreatorPrivacy {
  privacy_level_options: readonly TikTokPrivacyOption[];
}

export const cannotPublish = (
  capability: Capability | undefined,
  environment: PublicConfig["environment"] | undefined
): boolean =>
  capability === undefined ||
  !capability.configured ||
  ["disabled", "review_pending", "inbox_only"].includes(capability.mode) ||
  (capability.mode === "development_only" && environment !== "development");

export const privateTikTokAccountEligible = (
  creatorInfo: TikTokCreatorPrivacy | null
): boolean =>
  creatorInfo !== null &&
  creatorInfo.privacy_level_options.includes("SELF_ONLY") &&
  creatorInfo.privacy_level_options.includes("FOLLOWER_OF_CREATOR") &&
  !creatorInfo.privacy_level_options.includes("PUBLIC_TO_EVERYONE");

export const resolveTikTokPrivacy = (
  mode: CapabilityMode | undefined,
  creatorInfo: TikTokCreatorPrivacy | null,
  selectedPrivacy: TikTokPrivacy
): TikTokPrivacyOption | null => {
  if (
    creatorInfo === null ||
    selectedPrivacy === "" ||
    !creatorInfo.privacy_level_options.includes(selectedPrivacy)
  ) {
    return null;
  }
  if (mode === "private_only" && selectedPrivacy !== "SELF_ONLY") {
    return null;
  }
  return selectedPrivacy;
};
