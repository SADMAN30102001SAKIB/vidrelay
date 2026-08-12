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
  readRemoteUploadUrl,
  safeStep,
  storeRemoteUploadUrl,
  unsafeStep,
  type PublishRuntime
} from "./runtime";

interface FacebookStatus {
  error: string | null;
  permalink: string | null;
  published: boolean;
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
      permalink_url: z.string().url().optional(),
      status: z
        .object({
          processing_phase: z.object({ status: z.string().optional() }).optional(),
          publishing_phase: z.object({ status: z.string().optional() }).optional(),
          uploading_phase: z.object({ status: z.string().optional() }).optional(),
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
        { operation: "facebook_reel_status" }
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
  const error = phases.find(value => value.includes("error") || value.includes("fail"));
  const publishing = response.status?.publishing_phase?.status?.toLowerCase();
  return {
    error: error ?? null,
    permalink: response.permalink_url ?? null,
    published:
      publishing === "complete" ||
      publishing === "completed" ||
      publishing === "published"
  };
};

export const publishFacebook = async (runtime: PublishRuntime): Promise<void> => {
  let context = await currentContext(runtime);
  const settings = facebookSettingsSchema.parse(JSON.parse(context.destination.settingsJson));
  let credentials = await freshCredentials(runtime, context);

  if (runtime.reconcileOnly) {
    if (context.destination.remoteSessionId === null) {
      throw new ProviderError({
        code: "reconciliation_identifier_missing",
        message: "Facebook did not return a video identifier.",
        outcomeUnknown: true
      });
    }
    const status = await facebookStatus(
      runtime,
      context.destination.remoteSessionId,
      credentials.accessToken
    );
    if (!status.published) {
      throw new ProviderError({
        code: "facebook_not_confirmed",
        message: "Facebook has not confirmed that the Reel is published.",
        outcomeUnknown: true
      });
    }
    await finishDestination(runtime.bindings, {
      attemptNumber: runtime.attemptNumber,
      destinationId: runtime.destinationId,
      providerPostId: context.destination.remoteSessionId,
      providerUrl: status.permalink ?? undefined,
      stage: "confirmed",
      status: "published"
    });
    return;
  }

  if (
    context.destination.remoteSessionId === null ||
    context.destination.remoteUploadUrlEncrypted === null
  ) {
    await runtime.step.do("facebook-create-reel-session", unsafeStep, async () => {
      const current = await currentContext(runtime);
      if (
        current.destination.remoteSessionId !== null &&
        current.destination.remoteUploadUrlEncrypted !== null
      ) {
        return { videoId: current.destination.remoteSessionId };
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
      await storeRemoteUploadUrl(
        runtime,
        response.video_id,
        response.upload_url,
        "remote_session_created"
      );
      return { videoId: response.video_id };
    });
  }

  context = await currentContext(runtime);
  credentials = await freshCredentials(runtime, context);
  await runtime.step.do("facebook-transfer-reel", safeStep, async () => {
    const current = await currentContext(runtime);
    if (
      current.destination.stage === "transferred" ||
      current.destination.stage === "publishing" ||
      current.destination.status === "published"
    ) {
      return { transferred: true };
    }
    const currentCredentials = await freshCredentials(runtime, current);
    const lease = await createMediaLease(createDb(runtime.bindings.DB), runtime.bindings, {
      destinationId: current.destination.id,
      purpose: "facebook",
      ttlMs: 24 * 60 * 60 * 1000,
      uploadId: current.upload.id
    });
    const uploadUrl = await readRemoteUploadUrl(runtime, current);
    const response = z
      .object({ success: z.boolean() })
      .parse(
        await providerJson<unknown>(
          uploadUrl,
          {
            headers: {
              Authorization: "OAuth " + currentCredentials.accessToken,
              file_url: lease.url
            },
            method: "POST"
          },
          { operation: "facebook_reel_transfer" }
        )
      );
    if (!response.success) {
      throw new ProviderError({
        code: "facebook_transfer_rejected",
        message: "Facebook rejected the Reel transfer."
      });
    }
    await updateDestination(
      runtime.bindings,
      runtime.destinationId,
      runtime.attemptNumber,
      { stage: "transferred", status: "processing" }
    );
    return { transferred: true };
  });

  await runtime.step.do("facebook-finish-reel", unsafeStep, async () => {
    const current = await currentContext(runtime);
    const videoId = current.destination.remoteSessionId;
    if (videoId === null) {
      throw new ProviderError({
        code: "facebook_video_id_missing",
        message: "The Facebook video identifier is missing."
      });
    }
    const currentCredentials = await freshCredentials(runtime, current);
    const existingStatus = await facebookStatus(
      runtime,
      videoId,
      currentCredentials.accessToken
    );
    if (existingStatus.published) {
      return { alreadyPublished: true };
    }
    const values: Record<string, string> = {
      description: settings.description,
      upload_phase: "finish",
      video_id: videoId,
      video_state: "PUBLISHED"
    };
    if (settings.title !== undefined && settings.title.length > 0) {
      values.title = settings.title;
    }
    const response = z
      .object({ success: z.boolean() })
      .parse(
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
    await updateDestination(
      runtime.bindings,
      runtime.destinationId,
      runtime.attemptNumber,
      { stage: "publishing", status: "publishing" }
    );
    return { alreadyPublished: false };
  });

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
      await finishDestination(runtime.bindings, {
        attemptNumber: runtime.attemptNumber,
        destinationId: runtime.destinationId,
        providerPostId: context.destination.remoteSessionId ?? undefined,
        providerUrl: result.permalink ?? undefined,
        stage: "confirmed",
        status: "published"
      });
      return;
    }
    await runtime.step.sleep("facebook-poll-wait-" + String(index), "30 seconds");
  }

  throw new ProviderError({
    code: "facebook_processing_timeout",
    message: "Facebook has not confirmed the Reel after one hour.",
    outcomeUnknown: true
  });
};
