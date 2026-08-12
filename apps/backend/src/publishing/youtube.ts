import { youtubeSettingsSchema } from "@vidrelay/shared";
import { z } from "zod";

import { ProviderError } from "../lib/errors";
import { finishDestination, updateDestination } from "./repository";
import {
  currentContext,
  freshCredentials,
  readRemoteUploadUrl,
  safeStep,
  storeRemoteUploadUrl,
  type PublishRuntime
} from "./runtime";

interface UploadProbe {
  complete: boolean;
  offset: number;
  videoId: string | null;
}

const parseVideo = async (response: Response): Promise<string> => {
  const body: unknown = await response.json();
  return z.object({ id: z.string().min(1) }).parse(body).id;
};

const youtubeError = async (
  response: Response,
  operation: string,
  retryable: boolean
): Promise<ProviderError> => {
  let message = "YouTube rejected the request.";
  try {
    const body = z
      .object({
        error: z.object({ message: z.string().optional() }).optional()
      })
      .parse(await response.json());
    message = body.error?.message?.slice(0, 300) ?? message;
  } catch {
    message = "YouTube rejected the request with status " + String(response.status) + ".";
  }
  return new ProviderError({
    code: response.status === 401 ? "reauth_required" : operation,
    message:
      response.status === 401
        ? "Reconnect the YouTube channel before publishing again."
        : message,
    providerStatus: response.status,
    retryable
  });
};

const fetchYoutube = async (
  url: string,
  init: RequestInit,
  operation: string
): Promise<Response> => {
  try {
    return await fetch(url, init);
  } catch {
    throw new ProviderError({
      code: operation + "_network_error",
      message: "The YouTube request did not return a response.",
      retryable: true
    });
  }
};

const offsetFromRange = (range: string | null): number => {
  if (range === null) {
    return 0;
  }
  const match = /(?:bytes=)?0-(\d+)/.exec(range);
  return match === null ? 0 : Number(match[1]) + 1;
};

const probeUpload = async (
  sessionUrl: string,
  accessToken: string,
  size: number
): Promise<UploadProbe> => {
  const response = await fetchYoutube(
    sessionUrl,
    {
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Length": "0",
        "Content-Range": "bytes */" + String(size)
      },
      method: "PUT"
    },
    "youtube_upload_probe"
  );
  if (response.status === 308) {
    return {
      complete: false,
      offset: offsetFromRange(response.headers.get("Range")),
      videoId: null
    };
  }
  if (response.status === 200 || response.status === 201) {
    return { complete: true, offset: size, videoId: await parseVideo(response) };
  }
  if (response.status === 404 || response.status === 410) {
    throw new ProviderError({
      code: "youtube_session_expired",
      message: "The YouTube resumable upload session expired."
    });
  }
  throw await youtubeError(
    response,
    "youtube_upload_probe_failed",
    response.status === 429 || response.status >= 500
  );
};

const youtubeVideoStatus = async (
  videoId: string,
  accessToken: string
): Promise<{ failure: string | null; succeeded: boolean }> => {
  const response = await fetchYoutube(
    "https://www.googleapis.com/youtube/v3/videos?part=status%2CprocessingDetails&id=" +
      encodeURIComponent(videoId),
    {
      headers: { Authorization: "Bearer " + accessToken },
      method: "GET"
    },
    "youtube_video_status"
  );
  if (!response.ok) {
    throw await youtubeError(
      response,
      "youtube_video_status_failed",
      response.status === 429 || response.status >= 500
    );
  }
  const body = z
    .object({
      items: z.array(
        z.object({
          processingDetails: z
            .object({
              processingFailureReason: z.string().optional(),
              processingStatus: z.string().optional()
            })
            .optional(),
          status: z
            .object({
              failureReason: z.string().optional(),
              rejectionReason: z.string().optional(),
              uploadStatus: z.string().optional()
            })
            .optional()
        })
      )
    })
    .parse(await response.json());
  const item = body.items[0];
  if (item === undefined) {
    return { failure: null, succeeded: false };
  }
  const processing = item.processingDetails?.processingStatus?.toLowerCase();
  const upload = item.status?.uploadStatus?.toLowerCase();
  const failure =
    item.processingDetails?.processingFailureReason ??
    item.status?.failureReason ??
    item.status?.rejectionReason ??
    (processing === "failed" || upload === "failed" || upload === "rejected"
      ? "processing_failed"
      : null);
  return {
    failure,
    succeeded: processing === "succeeded" && failure === null
  };
};

const confirmYoutube = async (
  runtime: PublishRuntime,
  videoId: string
): Promise<void> => {
  for (let index = 0; index < 120; index += 1) {
    const status = await runtime.step.do(
      "youtube-processing-poll-" + String(index),
      safeStep,
      async () => {
        const current = await currentContext(runtime);
        const credentials = await freshCredentials(runtime, current);
        return await youtubeVideoStatus(videoId, credentials.accessToken);
      }
    );
    if (status.failure !== null) {
      throw new ProviderError({
        code: "youtube_processing_failed",
        message: "YouTube failed to process the video: " + status.failure.slice(0, 200)
      });
    }
    if (status.succeeded) {
      await finishDestination(runtime.bindings, {
        attemptNumber: runtime.attemptNumber,
        destinationId: runtime.destinationId,
        providerPostId: videoId,
        stage: "confirmed",
        status: "published"
      });
      return;
    }
    await runtime.step.sleep(
      "youtube-processing-poll-wait-" + String(index),
      "30 seconds"
    );
  }
  throw new ProviderError({
    code: "youtube_processing_timeout",
    message: "YouTube has not confirmed processing after one hour.",
    outcomeUnknown: true
  });
};

export const publishYoutube = async (runtime: PublishRuntime): Promise<void> => {
  let context = await currentContext(runtime);
  const settings = youtubeSettingsSchema.parse(
    JSON.parse(context.destination.settingsJson)
  );
  const credentials = await freshCredentials(runtime, context);

  if (context.destination.remotePostId !== null) {
    await confirmYoutube(runtime, context.destination.remotePostId);
    return;
  }

  if (runtime.reconcileOnly) {
    if (context.destination.remoteUploadUrlEncrypted === null) {
      throw new ProviderError({
        code: "youtube_reconciliation_identifier_missing",
        message: "YouTube did not return an upload identifier.",
        outcomeUnknown: true
      });
    }
    const sessionUrl = await readRemoteUploadUrl(runtime, context);
    const probe = await probeUpload(
      sessionUrl,
      credentials.accessToken,
      context.upload.expectedSize
    );
    if (!probe.complete || probe.videoId === null) {
      throw new ProviderError({
        code: "youtube_upload_incomplete",
        message: "The YouTube upload is incomplete and can be resumed with Retry."
      });
    }
    await updateDestination(
      runtime.bindings,
      runtime.destinationId,
      runtime.attemptNumber,
      {
        remotePostId: probe.videoId,
        stage: "processing",
        status: "processing",
        uploadOffset: probe.offset
      }
    );
    await confirmYoutube(runtime, probe.videoId);
    return;
  }

  if (context.destination.remoteUploadUrlEncrypted === null) {
    await runtime.step.do("youtube-create-resumable-session", safeStep, async () => {
      const current = await currentContext(runtime);
      if (current.destination.remoteUploadUrlEncrypted !== null) {
        return { created: false };
      }
      const currentCredentials = await freshCredentials(runtime, current);
      const response = await fetchYoutube(
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus",
        {
          body: JSON.stringify({
            snippet: {
              categoryId: settings.categoryId,
              description: settings.description,
              title: settings.title
            },
            status: {
              containsSyntheticMedia: settings.containsSyntheticMedia,
              privacyStatus: settings.privacyStatus,
              selfDeclaredMadeForKids: settings.madeForKids
            }
          }),
          headers: {
            Authorization: "Bearer " + currentCredentials.accessToken,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": String(current.upload.expectedSize),
            "X-Upload-Content-Type": current.upload.mimeType
          },
          method: "POST"
        },
        "youtube_session_create"
      );
      if (!response.ok) {
        throw await youtubeError(
          response,
          "youtube_session_create_failed",
          response.status === 429 || response.status >= 500
        );
      }
      const location = response.headers.get("Location");
      if (location === null) {
        throw new ProviderError({
          code: "youtube_session_location_missing",
          message: "YouTube did not return a resumable upload URL."
        });
      }
      const uploadId = new URL(location).searchParams.get("upload_id") ?? "resumable";
      await storeRemoteUploadUrl(
        runtime,
        uploadId,
        location,
        "remote_session_created"
      );
      return { created: true };
    });
  }

  context = await currentContext(runtime);
  let offset = context.destination.uploadOffset;
  const total = context.upload.expectedSize;
  const chunkSize = 16 * 1024 * 1024;
  for (let index = 0; index < Math.ceil(total / chunkSize) + 2; index += 1) {
    const result = await runtime.step.do(
      "youtube-transfer-chunk-" + String(index),
      {
        retries: {
          backoff: "exponential",
          delay: "5 seconds",
          limit: 8
        },
        timeout: "10 minutes"
      },
      async () => {
        const current = await currentContext(runtime);
        const currentCredentials = await freshCredentials(runtime, current);
        const sessionUrl = await readRemoteUploadUrl(runtime, current);
        let probe: UploadProbe;
        try {
          probe = await probeUpload(
            sessionUrl,
            currentCredentials.accessToken,
            current.upload.expectedSize
          );
        } catch (error) {
          if (error instanceof ProviderError && error.code === "youtube_session_expired") {
            await updateDestination(
              runtime.bindings,
              runtime.destinationId,
              runtime.attemptNumber,
              {
                remoteSessionId: null,
                remoteUploadUrlEncrypted: null,
                stage: "session_expired",
                uploadOffset: 0
              }
            );
          }
          throw error;
        }
        if (probe.complete) {
          return probe;
        }

        const start = probe.offset;
        const length = Math.min(chunkSize, current.upload.expectedSize - start);
        if (length <= 0) {
          return probe;
        }
        const object = await runtime.bindings.MEDIA.get(current.upload.r2Key, {
          range: { length, offset: start }
        });
        if (object === null) {
          throw new ProviderError({
            code: "source_media_missing",
            message: "The source video is missing from storage."
          });
        }
        const body = await object.arrayBuffer();
        const end = start + body.byteLength - 1;
        const response = await fetchYoutube(
          sessionUrl,
          {
            body,
            headers: {
              Authorization: "Bearer " + currentCredentials.accessToken,
              "Content-Range":
                "bytes " +
                String(start) +
                "-" +
                String(end) +
                "/" +
                String(current.upload.expectedSize),
              "Content-Type": current.upload.mimeType
            },
            method: "PUT"
          },
          "youtube_chunk_upload"
        );
        if (response.status === 308) {
          const nextOffset = offsetFromRange(response.headers.get("Range"));
          await updateDestination(
            runtime.bindings,
            runtime.destinationId,
            runtime.attemptNumber,
            {
              stage: "transferring",
              status: "transferring",
              uploadOffset: nextOffset
            }
          );
          return { complete: false, offset: nextOffset, videoId: null };
        }
        if (response.status === 200 || response.status === 201) {
          const videoId = await parseVideo(response);
          await updateDestination(
            runtime.bindings,
            runtime.destinationId,
            runtime.attemptNumber,
            {
              remotePostId: videoId,
              stage: "processing",
              status: "processing",
              uploadOffset: current.upload.expectedSize
            }
          );
          return {
            complete: true,
            offset: current.upload.expectedSize,
            videoId
          };
        }
        throw await youtubeError(
          response,
          "youtube_chunk_upload_failed",
          response.status === 429 || response.status >= 500
        );
      }
    );
    offset = result.offset;
    if (result.complete && result.videoId !== null) {
      await confirmYoutube(runtime, result.videoId);
      return;
    }
    if (offset >= total) {
      continue;
    }
  }

  throw new ProviderError({
    code: "youtube_upload_incomplete",
    message: "The YouTube upload did not reach a confirmed terminal response.",
    outcomeUnknown: true
  });
};
