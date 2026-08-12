import type { Bindings } from "../env";
import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createDb } from "../db/client";
import { requireSecret } from "../env";
import { decryptJson, encryptJson } from "../lib/crypto";
import { ProviderError } from "../lib/errors";
import {
  ensureFreshCredentials,
  type StoredCredentials
} from "../platforms/credentials";
import {
  loadPublishContext,
  type PublishContext,
  updateDestination
} from "./repository";

export interface PublishRuntime {
  attemptNumber: number;
  bindings: Bindings;
  destinationId: string;
  reconcileOnly: boolean;
  step: WorkflowStep;
}

export const safeStep = {
  retries: {
    backoff: "exponential" as const,
    delay: "5 seconds",
    limit: 5
  },
  timeout: "5 minutes"
} satisfies WorkflowStepConfig;

export const unsafeStep = {
  retries: {
    delay: "1 second",
    limit: 0
  },
  timeout: "5 minutes"
} satisfies WorkflowStepConfig;

export const currentContext = async (
  runtime: PublishRuntime
): Promise<PublishContext> => {
  const context = await loadPublishContext(runtime.bindings, runtime.destinationId);
  if (context?.destination.attemptNumber !== runtime.attemptNumber) {
    throw new NonRetryableError("The publication attempt is no longer current.");
  }
  if (context.destination.status === "cancelled") {
    throw new NonRetryableError("The publication was cancelled.");
  }
  if (context.upload.status !== "ready") {
    throw new ProviderError({
      code: "upload_not_ready",
      message: "The source upload is no longer ready."
    });
  }
  if (context.connection.status !== "connected") {
    throw new ProviderError({
      code: "reauth_required",
      message: "Reconnect the destination account."
    });
  }
  return context;
};

export const freshCredentials = async (
  runtime: PublishRuntime,
  context: PublishContext
): Promise<StoredCredentials> =>
  await ensureFreshCredentials(
    createDb(runtime.bindings.DB),
    runtime.bindings,
    context.connection
  );

export const storeRemoteUploadUrl = async (
  runtime: PublishRuntime,
  remoteSessionId: string,
  url: string,
  stage: string
): Promise<void> => {
  const encrypted = await encryptJson(
    { url },
    requireSecret(runtime.bindings.TOKEN_ENCRYPTION_KEY, "TOKEN_ENCRYPTION_KEY")
  );
  await updateDestination(
    runtime.bindings,
    runtime.destinationId,
    runtime.attemptNumber,
    {
      remoteSessionId,
      remoteUploadUrlEncrypted: encrypted,
      stage,
      status: "starting"
    }
  );
};

export const readRemoteUploadUrl = async (
  runtime: PublishRuntime,
  context: PublishContext
): Promise<string> => {
  if (context.destination.remoteUploadUrlEncrypted === null) {
    throw new ProviderError({
      code: "remote_upload_session_missing",
      message: "The provider upload session is missing."
    });
  }
  const value = await decryptJson<{ url: string }>(
    context.destination.remoteUploadUrlEncrypted,
    requireSecret(runtime.bindings.TOKEN_ENCRYPTION_KEY, "TOKEN_ENCRYPTION_KEY")
  );
  return value.url;
};
