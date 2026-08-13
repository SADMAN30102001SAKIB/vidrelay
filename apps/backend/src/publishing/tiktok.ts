import { tiktokSettingsSchema } from "@vidrelay/shared";
import { z } from "zod";

import { createDb } from "../db/client";
import { getCapability } from "../lib/capabilities";
import { ProviderError } from "../lib/errors";
import { createMediaLease } from "../lib/media-leases";
import { finishDestination, updateDestination } from "./repository";
import {
  currentContext,
  freshCredentials,
  safeStep,
  unsafeStep,
  type PublishRuntime
} from "./runtime";

const tiktokErrorSchema = z.object({
  code: z.string(),
  log_id: z.string().optional(),
  message: z.string().optional()
});

const tiktokEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  error: tiktokErrorSchema
});

const privacyLevelSchema = z.enum([
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY"
]);

const creatorInfoSchema = z.object({
  comment_disabled: z.boolean(),
  creator_avatar_url: z.string().url().optional(),
  creator_nickname: z.string(),
  creator_username: z.string(),
  duet_disabled: z.boolean(),
  max_video_post_duration_sec: z.number().int().positive(),
  privacy_level_options: z.array(privacyLevelSchema),
  stitch_disabled: z.boolean()
});

const publishInitSchema = z.object({
  publish_id: z.string().min(1).max(64)
});

const publishStatusSchema = z.object({
  downloaded_bytes: z.number().int().nonnegative().optional(),
  fail_reason: z.string().optional(),
  publicaly_available_post_id: z
    .array(z.union([z.string(), z.number()]))
    .optional(),
  status: z.enum([
    "PROCESSING_UPLOAD",
    "PROCESSING_DOWNLOAD",
    "SEND_TO_USER_INBOX",
    "PUBLISH_COMPLETE",
    "FAILED"
  ]),
  uploaded_bytes: z.number().int().nonnegative().optional()
});

type CreatorInfo = z.infer<typeof creatorInfoSchema>;
type PublishStatus = z.infer<typeof publishStatusSchema>;

const retryableFailureReasons = new Set(["internal", "video_pull_failed"]);
const authorizationErrorCodes = new Set([
  "access_token_invalid",
  "auth_removed",
  "scope_not_authorized",
  "token_not_authorized_for_specified_publish_id"
]);

const apiError = (
  code: string,
  message: string | undefined,
  providerStatus: number | undefined,
  outcomeUnknown: boolean
): ProviderError =>
  new ProviderError({
    code: authorizationErrorCodes.has(code)
      ? "reauth_required"
      : "tiktok_" + code,
    message: authorizationErrorCodes.has(code)
      ? "Reconnect the TikTok account before publishing again."
      : (message?.slice(0, 300) ?? "TikTok rejected the request."),
    outcomeUnknown: authorizationErrorCodes.has(code) ? false : outcomeUnknown,
    providerStatus,
    retryable: code === "internal_error" || code === "rate_limit_exceeded"
  });

const requestTikTok = async (
  url: string,
  init: RequestInit,
  operation: string,
  options: {
    failureOutcomeUnknown: boolean;
    replaySafe: boolean;
  }
): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ProviderError({
      code: operation + "_network_error",
      message: "The TikTok request did not return a response.",
      outcomeUnknown: options.failureOutcomeUnknown,
      retryable: options.replaySafe
    });
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ProviderError({
      code: operation + "_response_read_error",
      message: "The TikTok response could not be read.",
      outcomeUnknown: options.failureOutcomeUnknown,
      retryable: options.replaySafe
    });
  }
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  const envelope = tiktokEnvelopeSchema.safeParse(body);
  if (envelope.success && envelope.data.error.code !== "ok") {
    throw apiError(
      envelope.data.error.code,
      envelope.data.error.message,
      response.status,
      options.failureOutcomeUnknown &&
        (response.status >= 500 ||
          envelope.data.error.code === "internal_error")
    );
  }
  if (!response.ok) {
    throw new ProviderError({
      code: operation + "_http_" + String(response.status),
      message:
        "TikTok rejected the request with status " +
        String(response.status) +
        ".",
      outcomeUnknown: options.failureOutcomeUnknown,
      providerStatus: response.status,
      retryable:
        options.replaySafe &&
        (response.status === 429 || response.status >= 500)
    });
  }
  if (!envelope.success) {
    throw new ProviderError({
      code: operation + "_invalid_response",
      message: "TikTok returned an invalid response.",
      outcomeUnknown: options.failureOutcomeUnknown,
      retryable: options.replaySafe
    });
  }

  return envelope.data.data;
};

const queryCreatorInfo = async (accessToken: string): Promise<CreatorInfo> => {
  const parsed = creatorInfoSchema.safeParse(
    await requestTikTok(
      "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
      {
        body: "{}",
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json; charset=UTF-8"
        },
        method: "POST"
      },
      "tiktok_creator_info",
      { failureOutcomeUnknown: false, replaySafe: true }
    )
  );
  if (!parsed.success) {
    throw new ProviderError({
      code: "tiktok_creator_info_invalid_response",
      message: "TikTok returned invalid creator information."
    });
  }
  return parsed.data;
};

const fetchPublishStatus = async (
  publishId: string,
  accessToken: string
): Promise<PublishStatus> => {
  const parsed = publishStatusSchema.safeParse(
    await requestTikTok(
      "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
      {
        body: JSON.stringify({ publish_id: publishId }),
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json; charset=UTF-8"
        },
        method: "POST"
      },
      "tiktok_publish_status",
      { failureOutcomeUnknown: true, replaySafe: true }
    )
  );
  if (!parsed.success) {
    throw new ProviderError({
      code: "tiktok_publish_status_invalid_response",
      message: "TikTok returned an invalid publication status.",
      outcomeUnknown: true,
      retryable: true
    });
  }
  return parsed.data;
};

const validateDirectPostCapability = (
  runtime: PublishRuntime,
  settings: z.infer<typeof tiktokSettingsSchema>
): void => {
  const capability = getCapability(runtime.bindings, "tiktok");
  if (
    !capability.configured ||
    capability.mode === "disabled" ||
    capability.mode === "review_pending" ||
    capability.mode === "inbox_only" ||
    (capability.mode === "development_only" &&
      runtime.bindings.APP_ENV === "production")
  ) {
    throw new ProviderError({
      code: "capability_unavailable",
      message: capability.message
    });
  }
  if (
    capability.mode === "private_only" &&
    settings.privacyLevel !== "SELF_ONLY"
  ) {
    throw new ProviderError({
      code: "tiktok_private_only",
      message:
        "TikTok publishing is restricted to private visibility until audit approval."
    });
  }
  if (settings.brandedContent && settings.privacyLevel === "SELF_ONLY") {
    throw new ProviderError({
      code: "tiktok_branded_content_private_visibility",
      message: "TikTok branded content cannot use private visibility."
    });
  }
};

const validateCreatorInfo = (
  runtime: PublishRuntime,
  creator: CreatorInfo,
  settings: z.infer<typeof tiktokSettingsSchema>,
  durationMs: number
): void => {
  if (!creator.privacy_level_options.includes(settings.privacyLevel)) {
    throw new ProviderError({
      code: "tiktok_privacy_option_changed",
      message:
        "The selected TikTok visibility is no longer available for this account."
    });
  }
  if (
    getCapability(runtime.bindings, "tiktok").mode === "private_only" &&
    (!creator.privacy_level_options.includes("FOLLOWER_OF_CREATOR") ||
      creator.privacy_level_options.includes("PUBLIC_TO_EVERYONE"))
  ) {
    throw new ProviderError({
      code: "tiktok_private_account_required",
      message:
        "Unaudited TikTok clients can only post while the creator account is private."
    });
  }
  if (durationMs > creator.max_video_post_duration_sec * 1000) {
    throw new ProviderError({
      code: "tiktok_duration_not_allowed",
      message:
        "This creator can currently post videos up to " +
        String(creator.max_video_post_duration_sec) +
        " seconds."
    });
  }
  if (creator.comment_disabled && !settings.disableComment) {
    throw new ProviderError({
      code: "tiktok_comment_setting_changed",
      message: "Comments are now disabled in the creator's TikTok settings."
    });
  }
  if (creator.duet_disabled && !settings.disableDuet) {
    throw new ProviderError({
      code: "tiktok_duet_setting_changed",
      message: "Duets are now disabled in the creator's TikTok settings."
    });
  }
  if (creator.stitch_disabled && !settings.disableStitch) {
    throw new ProviderError({
      code: "tiktok_stitch_setting_changed",
      message: "Stitches are now disabled in the creator's TikTok settings."
    });
  }
};

const statusFailure = (status: PublishStatus): ProviderError => {
  const reason = status.fail_reason ?? "unknown";
  if (reason === "auth_removed") {
    return new ProviderError({
      code: "reauth_required",
      message:
        "The creator removed TikTok access while the post was processing."
    });
  }
  return new ProviderError({
    code: "tiktok_" + reason.slice(0, 100),
    message:
      "TikTok failed to publish the video: " + reason.slice(0, 200) + ".",
    retryable: retryableFailureReasons.has(reason)
  });
};

const confirmPublish = async (
  runtime: PublishRuntime,
  publishId: string
): Promise<void> => {
  for (let index = 0; index < 120; index += 1) {
    const status = await runtime.step.do(
      "tiktok-status-poll-" + String(index),
      safeStep,
      async () => {
        const current = await currentContext(runtime);
        const credentials = await freshCredentials(runtime, current);
        const result = await fetchPublishStatus(
          publishId,
          credentials.accessToken
        );
        if (
          result.status === "PROCESSING_DOWNLOAD" ||
          result.status === "PROCESSING_UPLOAD"
        ) {
          await updateDestination(
            runtime.bindings,
            runtime.destinationId,
            runtime.attemptNumber,
            {
              nextPollAt: Date.now() + 30_000,
              stage: result.status.toLowerCase(),
              status: "processing",
              uploadOffset:
                result.downloaded_bytes ?? result.uploaded_bytes ?? 0
            }
          );
        }
        return result;
      }
    );

    if (status.status === "FAILED") {
      throw statusFailure(status);
    }
    if (status.status === "SEND_TO_USER_INBOX") {
      await runtime.step.do(
        "tiktok-mark-awaiting-user-action",
        safeStep,
        async () => {
          await finishDestination(runtime.bindings, {
            attemptNumber: runtime.attemptNumber,
            destinationId: runtime.destinationId,
            stage: "awaiting_user_action",
            status: "awaiting_user_action"
          });
          return { persisted: true };
        }
      );
      return;
    }
    if (status.status === "PUBLISH_COMPLETE") {
      const publicPostId = status.publicaly_available_post_id?.find(
        value =>
          (typeof value === "string" && value.length > 0) ||
          (typeof value === "number" && Number.isSafeInteger(value))
      );
      await runtime.step.do("tiktok-mark-published", safeStep, async () => {
        await finishDestination(runtime.bindings, {
          attemptNumber: runtime.attemptNumber,
          destinationId: runtime.destinationId,
          providerPostId:
            typeof publicPostId === "string"
              ? publicPostId
              : typeof publicPostId === "number"
                ? String(publicPostId)
                : undefined,
          stage: "confirmed",
          status: "published"
        });
        return { persisted: true };
      });
      return;
    }

    await runtime.step.sleep(
      "tiktok-status-poll-wait-" + String(index),
      "30 seconds"
    );
  }

  throw new ProviderError({
    code: "tiktok_processing_timeout",
    message: "TikTok has not confirmed the post after one hour.",
    outcomeUnknown: true
  });
};

export const publishTikTok = async (runtime: PublishRuntime): Promise<void> => {
  let context = await currentContext(runtime);
  const settings = tiktokSettingsSchema.parse(
    JSON.parse(context.destination.settingsJson)
  );

  if (context.destination.remoteSessionId !== null) {
    if (!runtime.reconcileOnly && context.destination.stage === "queued") {
      const previousStatus = await runtime.step.do(
        "tiktok-check-previous-session",
        safeStep,
        async () => {
          const current = await currentContext(runtime);
          const credentials = await freshCredentials(runtime, current);
          return await fetchPublishStatus(
            current.destination.remoteSessionId ?? "",
            credentials.accessToken
          );
        }
      );
      if (
        previousStatus.status === "FAILED" &&
        retryableFailureReasons.has(previousStatus.fail_reason ?? "")
      ) {
        await runtime.step.do(
          "tiktok-retire-known-failed-session",
          safeStep,
          async () => {
            const current = await currentContext(runtime);
            if (current.destination.remoteSessionId !== null) {
              await updateDestination(
                runtime.bindings,
                runtime.destinationId,
                runtime.attemptNumber,
                {
                  nextPollAt: null,
                  remotePostId: null,
                  remoteSessionId: null,
                  stage: "retrying_known_failure",
                  status: "starting",
                  uploadOffset: 0
                }
              );
            }
            return { retired: true };
          }
        );
        context = await currentContext(runtime);
      }
    }

    if (context.destination.remoteSessionId !== null) {
      await confirmPublish(runtime, context.destination.remoteSessionId);
      return;
    }
  }

  if (runtime.reconcileOnly) {
    throw new ProviderError({
      code: "tiktok_reconciliation_identifier_missing",
      message: "TikTok did not return a publish identifier.",
      outcomeUnknown: true
    });
  }

  validateDirectPostCapability(runtime, settings);
  let scopes: unknown;
  try {
    scopes = JSON.parse(context.connection.scopesJson);
  } catch {
    scopes = null;
  }
  if (!Array.isArray(scopes) || !scopes.includes("video.publish")) {
    throw new ProviderError({
      code: "reauth_required",
      message: "Reconnect TikTok and grant the video.publish permission."
    });
  }
  if (context.upload.durationMs === null) {
    throw new ProviderError({
      code: "tiktok_duration_unverified",
      message: "The video duration could not be verified."
    });
  }

  const creator = await runtime.step.do(
    "tiktok-query-current-creator-info",
    safeStep,
    async () => {
      const current = await currentContext(runtime);
      const credentials = await freshCredentials(runtime, current);
      return await queryCreatorInfo(credentials.accessToken);
    }
  );
  validateCreatorInfo(runtime, creator, settings, context.upload.durationMs);

  await runtime.step.do(
    "tiktok-record-provider-commit-intent",
    safeStep,
    async () => {
      const current = await currentContext(runtime);
      if (current.destination.remoteSessionId === null) {
        await updateDestination(
          runtime.bindings,
          runtime.destinationId,
          runtime.attemptNumber,
          {
            outcomeUnknown: true,
            stage: "provider_commit_started",
            status: "starting"
          }
        );
      }
      return { recorded: true };
    }
  );

  const init = await runtime.step.do(
    "tiktok-direct-post-init",
    unsafeStep,
    async () => {
      const current = await currentContext(runtime);
      if (current.destination.remoteSessionId !== null) {
        return { publishId: current.destination.remoteSessionId };
      }
      const credentials = await freshCredentials(runtime, current);
      const lease = await createMediaLease(
        createDb(runtime.bindings.DB),
        runtime.bindings,
        {
          destinationId: current.destination.id,
          purpose: "tiktok",
          ttlMs: 2 * 60 * 60 * 1000,
          uploadId: current.upload.id
        }
      );
      if (new URL(lease.url).protocol !== "https:") {
        throw new ProviderError({
          code: "tiktok_source_url_not_https",
          message: "TikTok requires an HTTPS media URL on a verified domain."
        });
      }

      const parsed = publishInitSchema.safeParse(
        await requestTikTok(
          "https://open.tiktokapis.com/v2/post/publish/video/init/",
          {
            body: JSON.stringify({
              post_info: {
                brand_content_toggle: settings.brandedContent,
                brand_organic_toggle: settings.ownBrand,
                disable_comment: settings.disableComment,
                disable_duet: settings.disableDuet,
                disable_stitch: settings.disableStitch,
                is_aigc: settings.isAiGenerated,
                privacy_level: settings.privacyLevel,
                title: settings.title
              },
              source_info: {
                source: "PULL_FROM_URL",
                video_url: lease.url
              }
            }),
            headers: {
              Authorization: "Bearer " + credentials.accessToken,
              "Content-Type": "application/json; charset=UTF-8"
            },
            method: "POST"
          },
          "tiktok_publish_init",
          { failureOutcomeUnknown: true, replaySafe: false }
        )
      );
      if (!parsed.success) {
        throw new ProviderError({
          code: "tiktok_publish_init_invalid_response",
          message:
            "TikTok accepted the request but did not return a publish identifier.",
          outcomeUnknown: true
        });
      }
      return { publishId: parsed.data.publish_id };
    }
  );

  await runtime.step.do("tiktok-persist-publish-id", safeStep, async () => {
    const current = await currentContext(runtime);
    if (
      current.destination.remoteSessionId !== null &&
      current.destination.remoteSessionId !== init.publishId
    ) {
      throw new ProviderError({
        code: "tiktok_publish_id_conflict",
        message: "A different TikTok publish identifier is already recorded.",
        outcomeUnknown: true
      });
    }
    if (current.destination.remoteSessionId === null) {
      await updateDestination(
        runtime.bindings,
        runtime.destinationId,
        runtime.attemptNumber,
        {
          nextPollAt: Date.now(),
          outcomeUnknown: false,
          remoteSessionId: init.publishId,
          stage: "remote_session_created",
          status: "processing"
        }
      );
    }
    return { publishId: init.publishId };
  });

  context = await currentContext(runtime);
  if (context.destination.remoteSessionId === null) {
    throw new ProviderError({
      code: "tiktok_publish_id_missing",
      message: "TikTok did not return a publish identifier.",
      outcomeUnknown: true
    });
  }
  await confirmPublish(runtime, context.destination.remoteSessionId);
};
