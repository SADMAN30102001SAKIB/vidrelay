import { instagramSettingsSchema } from "@vidrelay/shared";
import { z } from "zod";

import { createDb } from "../db/client";
import { ProviderError } from "../lib/errors";
import { createMediaLease } from "../lib/media-leases";
import { formBody, providerJson } from "../platforms/http";
import { finishDestination, updateDestination } from "./repository";
import {
  currentContext,
  freshCredentials,
  safeStep,
  unsafeStep,
  type PublishRuntime
} from "./runtime";

const containerStatus = async (
  runtime: PublishRuntime,
  containerId: string,
  accessToken: string
): Promise<string | null> => {
  const url = new URL(
    "https://graph.instagram.com/" +
      runtime.bindings.META_GRAPH_VERSION +
      "/" +
      encodeURIComponent(containerId)
  );
  url.searchParams.set("fields", "status_code,status");
  const response = z
    .object({
      status_code: z.string().optional()
    })
    .parse(
      await providerJson<unknown>(
        url.toString(),
        {
          headers: { Authorization: "Bearer " + accessToken },
          method: "GET"
        },
        { operation: "instagram_media_status" }
      )
    );
  return response.status_code?.toUpperCase() ?? null;
};

const publishedMedia = async (
  runtime: PublishRuntime,
  mediaId: string,
  accessToken: string
): Promise<{ permalink: string | null }> => {
  const url = new URL(
    "https://graph.instagram.com/" +
      runtime.bindings.META_GRAPH_VERSION +
      "/" +
      encodeURIComponent(mediaId)
  );
  url.searchParams.set("fields", "id,permalink");
  const response = z
    .object({
      id: z.union([z.string(), z.number()]).transform(String),
      permalink: z.string().url().optional()
    })
    .parse(
      await providerJson<unknown>(
        url.toString(),
        {
          headers: { Authorization: "Bearer " + accessToken },
          method: "GET"
        },
        { operation: "instagram_published_media" }
      )
    );
  if (response.id !== mediaId) {
    throw new ProviderError({
      code: "instagram_media_id_mismatch",
      message: "Instagram returned a different published media identifier.",
      outcomeUnknown: true
    });
  }
  return { permalink: response.permalink ?? null };
};

export const publishInstagram = async (runtime: PublishRuntime): Promise<void> => {
  let context = await currentContext(runtime);
  const settings = instagramSettingsSchema.parse(
    JSON.parse(context.destination.settingsJson)
  );
  let credentials = await freshCredentials(runtime, context);

  if (runtime.reconcileOnly) {
    if (context.destination.remotePostId === null) {
      throw new ProviderError({
        code: "instagram_media_id_missing",
        message: "Instagram did not return a published media identifier.",
        outcomeUnknown: true
      });
    }
    const status = await publishedMedia(
      runtime,
      context.destination.remotePostId,
      credentials.accessToken
    );
    await finishDestination(runtime.bindings, {
      attemptNumber: runtime.attemptNumber,
      destinationId: runtime.destinationId,
      providerPostId: context.destination.remotePostId,
      providerUrl: status.permalink ?? undefined,
      stage: "confirmed",
      status: "published"
    });
    return;
  }

  if (
    context.destination.remoteSessionId !== null &&
    context.destination.stage === "queued"
  ) {
    const previousStatus = await runtime.step.do(
      "instagram-check-previous-container",
      safeStep,
      async () => {
        const current = await currentContext(runtime);
        const currentCredentials = await freshCredentials(runtime, current);
        return await containerStatus(
          runtime,
          current.destination.remoteSessionId ?? "",
          currentCredentials.accessToken
        );
      }
    );
    if (
      previousStatus === "ERROR" ||
      previousStatus === "EXPIRED"
    ) {
      await runtime.step.do(
        "instagram-retire-known-failed-container",
        safeStep,
        async () => {
          await updateDestination(
            runtime.bindings,
            runtime.destinationId,
            runtime.attemptNumber,
            {
              remoteSessionId: null,
              stage: "retrying_known_container_failure",
              status: "starting"
            }
          );
          return { retired: true };
        }
      );
      context = await currentContext(runtime);
    }
  }

  if (context.destination.remoteSessionId === null) {
    await runtime.step.do("instagram-create-container", unsafeStep, async () => {
      const current = await currentContext(runtime);
      if (current.destination.remoteSessionId !== null) {
        return { containerId: current.destination.remoteSessionId };
      }
      const currentCredentials = await freshCredentials(runtime, current);
      const lease = await createMediaLease(createDb(runtime.bindings.DB), runtime.bindings, {
        destinationId: current.destination.id,
        purpose: "instagram",
        ttlMs: 24 * 60 * 60 * 1000,
        uploadId: current.upload.id
      });
      const response = z
        .object({ id: z.union([z.string(), z.number()]).transform(String) })
        .parse(
          await providerJson<unknown>(
            "https://graph.instagram.com/" +
              runtime.bindings.META_GRAPH_VERSION +
              "/" +
              encodeURIComponent(current.connection.remoteAccountId) +
              "/media",
            {
              body: formBody({
                caption: settings.caption,
                media_type: "REELS",
                share_to_feed: settings.shareToFeed ? "true" : "false",
                video_url: lease.url
              }),
              headers: {
                Authorization: "Bearer " + currentCredentials.accessToken,
                "Content-Type": "application/x-www-form-urlencoded"
              },
              method: "POST"
            },
            { operation: "instagram_container_create", outcomeUnknown: true }
          )
        );
      await updateDestination(
        runtime.bindings,
        runtime.destinationId,
        runtime.attemptNumber,
        {
          remoteSessionId: response.id,
          stage: "remote_session_created",
          status: "processing"
        }
      );
      return { containerId: response.id };
    });
  }

  for (let index = 0; index < 60; index += 1) {
    const result = await runtime.step.do(
      "instagram-container-poll-" + String(index),
      safeStep,
      async () => {
        const current = await currentContext(runtime);
        if (current.destination.remoteSessionId === null) {
          throw new ProviderError({
            code: "instagram_container_missing",
            message: "The Instagram media container is missing."
          });
        }
        const currentCredentials = await freshCredentials(runtime, current);
        return await containerStatus(
          runtime,
          current.destination.remoteSessionId,
          currentCredentials.accessToken
        );
      }
    );
    if (result === "FINISHED") {
      break;
    }
    if (result === "ERROR" || result === "EXPIRED") {
      throw new ProviderError({
        code: "instagram_container_" + result.toLowerCase(),
        message: "Instagram could not process the Reel container."
      });
    }
    if (index === 59) {
      throw new ProviderError({
        code: "instagram_processing_timeout",
        message: "Instagram has not finished processing the Reel after 30 minutes.",
        retryable: true
      });
    }
    await runtime.step.sleep(
      "instagram-container-poll-wait-" + String(index),
      "30 seconds"
    );
  }

  await runtime.step.do("instagram-publish-container", unsafeStep, async () => {
    const current = await currentContext(runtime);
    if (current.destination.remotePostId !== null) {
      return { mediaId: current.destination.remotePostId };
    }
    if (current.destination.remoteSessionId === null) {
      throw new ProviderError({
        code: "instagram_container_missing",
        message: "The Instagram media container is missing."
      });
    }
    const currentCredentials = await freshCredentials(runtime, current);
    const response = z
      .object({ id: z.union([z.string(), z.number()]).transform(String) })
      .parse(
        await providerJson<unknown>(
          "https://graph.instagram.com/" +
            runtime.bindings.META_GRAPH_VERSION +
            "/" +
            encodeURIComponent(current.connection.remoteAccountId) +
            "/media_publish",
          {
            body: formBody({ creation_id: current.destination.remoteSessionId }),
            headers: {
              Authorization: "Bearer " + currentCredentials.accessToken,
              "Content-Type": "application/x-www-form-urlencoded"
            },
            method: "POST"
          },
          { operation: "instagram_media_publish", outcomeUnknown: true }
        )
      );
    await updateDestination(
      runtime.bindings,
      runtime.destinationId,
      runtime.attemptNumber,
      {
        remotePostId: response.id,
        stage: "publishing",
        status: "publishing"
      }
    );
    return { mediaId: response.id };
  });

  context = await currentContext(runtime);
  credentials = await freshCredentials(runtime, context);
  if (context.destination.remotePostId === null) {
    throw new ProviderError({
      code: "instagram_media_id_missing",
      message: "Instagram did not return a published media identifier.",
      outcomeUnknown: true
    });
  }
  await finishDestination(runtime.bindings, {
    attemptNumber: runtime.attemptNumber,
    destinationId: runtime.destinationId,
    providerPostId: context.destination.remotePostId,
    stage: "confirmed",
    status: "published"
  });
};
