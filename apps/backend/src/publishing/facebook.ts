import { facebookSettingsSchema } from "@vidrelay/shared";
import { z } from "zod";

import { createDb } from "../db/client";
import { createMediaLease } from "../lib/media-leases";
import { ProviderError } from "../lib/errors";
import { providerJson, formBody } from "../platforms/http";
import { finishDestination, updateDestination } from "./repository";
import {
  currentContext,
  freshCredentials,
  protectRemoteUploadUrl,
  readRemoteUploadUrl,
  safeStep,
  sensitiveUnsafeStep,
  storeProtectedRemoteUploadUrl,
  unsafeStep,
  type PublishRuntime
} from "./runtime";

interface FacebookStatus {
  error: string | null;
  permalink: string | null;
  published: boolean;
  publishingStarted: boolean;
  transferred: boolean;
}

const facebookStatus = async (
  runtime: PublishRuntime,
  videoId: string,
  accessToken: string
): Promise<FacebookStatus> => {
  const url = new URL(
    "https://graph.facebook.com/" +
      runtime.bindings.META_GRAPH_VERSION +
      "/" +
      encodeURIComponent(videoId)
  );
  url.searchParams.set("fields", "status,permalink_url");
  const response = z
    .object({
      permalink_url: z.string().url().startsWith("https://").optional(),
      status: z
        .object({
          processing_phase: z
            .object({ status: z.string().optional() })
            .optional(),
          publishing_phase: z
            .object({ status: z.string().optional() })
            .optional(),
          uploading_phase: z
            .object({ status: z.string().optional() })
            .optional(),
          video_status: z.string().optional()
        })
        .optional()
    })
    .parse(
      await providerJson<unknown>(
        url.toString(),
        {
          headers: { Authorization: "Bearer " + accessToken },
          method: "GET"
        },
        { operation: "facebook_reel_status", outcomeUnknown: true }
      )
    );
  const phases = [
    response.status?.uploading_phase?.status,
    response.status?.processing_phase?.status,
    response.status?.publishing_phase?.status,
    response.status?.video_status
  ]
    .filter((value): value is string => value !== undefined)
    .map(value => value.toLowerCase());
  const error = phases.find(
    value => value.includes("error") || value.includes("fail")
  );
  const uploading = response.status?.uploading_phase?.status?.toLowerCase();
  const processing = response.status?.processing_phase?.status?.toLowerCase();
  const publishing = response.status?.publishing_phase?.status?.toLowerCase();
  const videoStatus = response.status?.video_status?.toLowerCase();
  const started = (value: string | undefined): boolean =>
    value !== undefined &&
    !["not_started", "not started", "pending"].includes(value);
  const complete = (value: string | undefined): boolean =>
    value !== undefined &&
    ["complete", "completed", "published", "ready"].includes(value);
  return {
    error: error ?? null,
    permalink: response.permalink_url ?? null,
    published: complete(publishing) || videoStatus === "published",
    publishingStarted: started(publishing),
    transferred:
      complete(uploading) ||
      started(processing) ||
      started(publishing) ||
      ["processing", "ready", "published"].includes(videoStatus ?? "")
  };
};

export const publishFacebook = async (
  runtime: PublishRuntime
): Promise<void> => {
  let context = await currentContext(runtime);
  const settings = facebookSettingsSchema.parse(
    JSON.parse(context.destination.settingsJson)
  );

  if (runtime.reconcileOnly) {
    if (context.destination.remoteSessionId === null) {
      throw new ProviderError({
        code: "reconciliation_identifier_missing",
        message: "Facebook did not return a video identifier.",
        outcomeUnknown: true
      });
    }
    await runtime.step.do(
      "facebook-reconcile-published-reel",
      safeStep,
      async () => {
        const current = await currentContext(runtime);
        const credentials = await freshCredentials(runtime, current);
        const status = await facebookStatus(
          runtime,
          current.destination.remoteSessionId ?? "",
          credentials.accessToken
        );
        if (
          !status.published &&
          status.error === null &&
          status.publishingStarted
        ) {
          throw new ProviderError({
            code: "facebook_not_confirmed",
            message:
              "Facebook is still publishing the Reel. Reconcile it again later.",
            outcomeUnknown: true
          });
        }
        if (!status.published) {
          await finishDestination(runtime.bindings, {
            attemptNumber: runtime.attemptNumber,
            destinationId: runtime.destinationId,
            errorCode:
              status.error === null
                ? "facebook_publish_not_started"
                : "facebook_processing_failed",
            errorMessage:
              status.error === null
                ? "Facebook has not started publishing this Reel. Retry is available."
                : "Facebook reported that this Reel session failed. Retry is available.",
            stage: "facebook_reconciliation_retryable",
            status: "failed_permanent"
          });
          return { published: false };
        }
        await finishDestination(runtime.bindings, {
          attemptNumber: runtime.attemptNumber,
          destinationId: runtime.destinationId,
          providerPostId: current.destination.remoteSessionId ?? undefined,
          providerUrl: status.permalink ?? undefined,
          stage: "confirmed",
          status: "published"
        });
        return { published: true };
      }
    );
    return;
  }

  let transferComplete = ["transferred", "processing", "publishing"].includes(
    context.destination.stage
  );
  let publishStarted = context.destination.stage === "publishing";
  if (
    context.destination.remoteSessionId !== null &&
    context.destination.remoteUploadUrlEncrypted !== null
  ) {
    const existing = await runtime.step.do(
      "facebook-probe-existing-reel-session",
      safeStep,
      async () => {
        const current = await currentContext(runtime);
        const credentials = await freshCredentials(runtime, current);
        return await facebookStatus(
          runtime,
          current.destination.remoteSessionId ?? "",
          credentials.accessToken
        );
      }
    );
    if (existing.published) {
      await runtime.step.do(
        "facebook-confirm-existing-published-reel",
        safeStep,
        async () => {
          await finishDestination(runtime.bindings, {
            attemptNumber: runtime.attemptNumber,
            destinationId: runtime.destinationId,
            providerPostId: context.destination.remoteSessionId ?? undefined,
            providerUrl: existing.permalink ?? undefined,
            stage: "confirmed",
            status: "published"
          });
          return { published: true };
        }
      );
      return;
    }
    if (existing.error !== null) {
      await runtime.step.do(
        "facebook-retire-failed-session",
        safeStep,
        async () => {
          await updateDestination(
            runtime.bindings,
            runtime.destinationId,
            runtime.attemptNumber,
            {
              outcomeUnknown: false,
              remotePostId: null,
              remoteSessionId: null,
              remoteUploadUrlEncrypted: null,
              remoteUrl: null,
              stage: "retrying_known_session_failure",
              status: "starting",
              uploadOffset: 0
            }
          );
          return { retired: true };
        }
      );
      context = await currentContext(runtime);
      transferComplete = false;
      publishStarted = false;
    } else {
      transferComplete = transferComplete || existing.transferred;
      publishStarted = publishStarted || existing.publishingStarted;
    }
  }

  if (
    context.destination.remoteSessionId === null ||
    context.destination.remoteUploadUrlEncrypted === null
  ) {
    await runtime.step.do(
      "facebook-record-session-create-intent",
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
    const session = await runtime.step.do(
      "facebook-create-reel-session",
      sensitiveUnsafeStep,
      async () => {
        const current = await currentContext(runtime);
        if (
          current.destination.remoteSessionId !== null &&
          current.destination.remoteUploadUrlEncrypted !== null
        ) {
          return null;
        }
        const currentCredentials = await freshCredentials(runtime, current);
        const response = z
          .object({
            upload_url: z.string().url(),
            video_id: z.union([z.string(), z.number()]).transform(String)
          })
          .parse(
            await providerJson<unknown>(
              "https://graph.facebook.com/" +
                runtime.bindings.META_GRAPH_VERSION +
                "/" +
                encodeURIComponent(current.connection.remoteAccountId) +
                "/video_reels",
              {
                body: formBody({ upload_phase: "start" }),
                headers: {
                  Authorization: "Bearer " + currentCredentials.accessToken,
                  "Content-Type": "application/x-www-form-urlencoded"
                },
                method: "POST"
              },
              { operation: "facebook_reel_start", outcomeUnknown: true }
            )
          );
        return {
          protectedUploadUrl: await protectRemoteUploadUrl(
            runtime,
            response.upload_url
          ),
          videoId: response.video_id
        };
      }
    );
    if (session !== null) {
      await runtime.step.do(
        "facebook-persist-reel-session",
        safeStep,
        async () => {
          await storeProtectedRemoteUploadUrl(
            runtime,
            session.videoId,
            session.protectedUploadUrl,
            "remote_session_created"
          );
          return { persisted: true };
        }
      );
    }
  }

  context = await currentContext(runtime);
  if (!transferComplete) {
    await runtime.step.do(
      "facebook-record-transfer-intent",
      safeStep,
      async () => {
        await updateDestination(
          runtime.bindings,
          runtime.destinationId,
          runtime.attemptNumber,
          {
            outcomeUnknown: true,
            stage: "provider_commit_started",
            status: "transferring"
          }
        );
        return { recorded: true };
      }
    );
    const transferred = await runtime.step.do(
      "facebook-transfer-reel",
      unsafeStep,
      async () => {
        const current = await currentContext(runtime);
        const currentCredentials = await freshCredentials(runtime, current);
        const lease = await createMediaLease(
          createDb(runtime.bindings.DB),
          runtime.bindings,
          {
            destinationId: current.destination.id,
            purpose: "facebook",
            ttlMs: 24 * 60 * 60 * 1000,
            uploadId: current.upload.id
          }
        );
        const uploadUrl = await readRemoteUploadUrl(runtime, current);
        const response = z.object({ success: z.boolean() }).parse(
          await providerJson<unknown>(
            uploadUrl,
            {
              headers: {
                Authorization: "OAuth " + currentCredentials.accessToken,
                file_url: lease.url
              },
              method: "POST"
            },
            { operation: "facebook_reel_transfer", outcomeUnknown: true }
          )
        );
        if (!response.success) {
          throw new ProviderError({
            code: "facebook_transfer_rejected",
            message: "Facebook rejected the Reel transfer."
          });
        }
        return { transferred: true };
      }
    );
    if (transferred.transferred) {
      await runtime.step.do("facebook-persist-transfer", safeStep, async () => {
        await updateDestination(
          runtime.bindings,
          runtime.destinationId,
          runtime.attemptNumber,
          {
            outcomeUnknown: false,
            stage: "transferred",
            status: "processing"
          }
        );
        return { persisted: true };
      });
    }
  }

  if (!publishStarted) {
    const beforeFinish = await runtime.step.do(
      "facebook-check-before-finish",
      safeStep,
      async () => {
        const current = await currentContext(runtime);
        const credentials = await freshCredentials(runtime, current);
        return await facebookStatus(
          runtime,
          current.destination.remoteSessionId ?? "",
          credentials.accessToken
        );
      }
    );
    if (beforeFinish.published) {
      const current = await currentContext(runtime);
      await runtime.step.do(
        "facebook-confirm-pre-finish-published-reel",
        safeStep,
        async () => {
          await finishDestination(runtime.bindings, {
            attemptNumber: runtime.attemptNumber,
            destinationId: runtime.destinationId,
            providerPostId: current.destination.remoteSessionId ?? undefined,
            providerUrl: beforeFinish.permalink ?? undefined,
            stage: "confirmed",
            status: "published"
          });
          return { published: true };
        }
      );
      return;
    }
    if (beforeFinish.error !== null) {
      throw new ProviderError({
        code: "facebook_processing_failed",
        message: "Facebook failed while processing the Reel."
      });
    }
    publishStarted = beforeFinish.publishingStarted;
  }

  if (!publishStarted) {
    await runtime.step.do(
      "facebook-record-finish-intent",
      safeStep,
      async () => {
        await updateDestination(
          runtime.bindings,
          runtime.destinationId,
          runtime.attemptNumber,
          {
            outcomeUnknown: true,
            stage: "provider_commit_started",
            status: "publishing"
          }
        );
        return { recorded: true };
      }
    );
    const finish = await runtime.step.do(
      "facebook-finish-reel",
      unsafeStep,
      async () => {
        const current = await currentContext(runtime);
        const videoId = current.destination.remoteSessionId;
        if (videoId === null) {
          throw new ProviderError({
            code: "facebook_video_id_missing",
            message: "The Facebook video identifier is missing."
          });
        }
        const currentCredentials = await freshCredentials(runtime, current);
        const values: Record<string, string> = {
          description: settings.description,
          upload_phase: "finish",
          video_id: videoId,
          video_state: "PUBLISHED"
        };
        if (settings.title !== undefined && settings.title.length > 0) {
          values.title = settings.title;
        }
        const response = z.object({ success: z.boolean() }).parse(
          await providerJson<unknown>(
            "https://graph.facebook.com/" +
              runtime.bindings.META_GRAPH_VERSION +
              "/" +
              encodeURIComponent(current.connection.remoteAccountId) +
              "/video_reels",
            {
              body: formBody(values),
              headers: {
                Authorization: "Bearer " + currentCredentials.accessToken,
                "Content-Type": "application/x-www-form-urlencoded"
              },
              method: "POST"
            },
            { operation: "facebook_reel_finish", outcomeUnknown: true }
          )
        );
        if (!response.success) {
          throw new ProviderError({
            code: "facebook_finish_rejected",
            message: "Facebook did not accept the publish request."
          });
        }
        return { accepted: true };
      }
    );
    if (finish.accepted) {
      await runtime.step.do("facebook-persist-finish", safeStep, async () => {
        await updateDestination(
          runtime.bindings,
          runtime.destinationId,
          runtime.attemptNumber,
          {
            outcomeUnknown: false,
            stage: "publishing",
            status: "publishing"
          }
        );
        return { persisted: true };
      });
    }
  }

  for (let index = 0; index < 120; index += 1) {
    const result = await runtime.step.do(
      "facebook-poll-" + String(index),
      safeStep,
      async () => {
        const current = await currentContext(runtime);
        if (current.destination.remoteSessionId === null) {
          throw new ProviderError({
            code: "facebook_video_id_missing",
            message: "The Facebook video identifier is missing."
          });
        }
        const currentCredentials = await freshCredentials(runtime, current);
        return await facebookStatus(
          runtime,
          current.destination.remoteSessionId,
          currentCredentials.accessToken
        );
      }
    );
    if (result.error !== null) {
      throw new ProviderError({
        code: "facebook_processing_failed",
        message: "Facebook failed while processing the Reel."
      });
    }
    if (result.published) {
      context = await currentContext(runtime);
      await runtime.step.do(
        "facebook-confirm-published-reel-" + String(index),
        safeStep,
        async () => {
          await finishDestination(runtime.bindings, {
            attemptNumber: runtime.attemptNumber,
            destinationId: runtime.destinationId,
            providerPostId: context.destination.remoteSessionId ?? undefined,
            providerUrl: result.permalink ?? undefined,
            stage: "confirmed",
            status: "published"
          });
          return { published: true };
        }
      );
      return;
    }
    await runtime.step.sleep(
      "facebook-poll-wait-" + String(index),
      "30 seconds"
    );
  }

  throw new ProviderError({
    code: "facebook_processing_timeout",
    message: "Facebook has not confirmed the Reel after one hour.",
    outcomeUnknown: true
  });
};
