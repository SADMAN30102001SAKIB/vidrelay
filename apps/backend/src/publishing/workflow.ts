import type { DestinationStatus, Platform } from "@vidrelay/shared";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";

import type { Bindings, PublishWorkflowParams } from "../env";
import { createDb } from "../db/client";
import { socialConnections } from "../db/schema";
import { getCapability } from "../lib/capabilities";
import { ProviderError } from "../lib/errors";
import { publishFacebook } from "./facebook";
import { publishInstagram } from "./instagram";
import {
  finishDestination,
  loadPublishContext,
  updateDestination
} from "./repository";
import { safeStep, type PublishRuntime } from "./runtime";
import { publishTikTok } from "./tiktok";
import { publishYoutube } from "./youtube";

interface DispatchState {
  platform: Platform;
  reconcileOnly: boolean;
  stopped: boolean;
}

interface GateFailure {
  code: string;
  message: string;
  status: DestinationStatus;
}

const terminalStatuses = new Set<DestinationStatus>([
  "published",
  "awaiting_user_action",
  "reauth_required",
  "failed_permanent",
  "reconciliation_required",
  "cancelled",
  "unavailable"
]);

const capabilityFailure = (
  bindings: Bindings,
  platform: Platform,
  settingsJson: string
): GateFailure | null => {
  const capability = getCapability(bindings, platform);
  if (
    !capability.configured ||
    capability.mode === "disabled" ||
    capability.mode === "review_pending" ||
    (capability.mode === "development_only" &&
      bindings.APP_ENV === "production") ||
    (platform === "tiktok" && capability.mode === "inbox_only")
  ) {
    return {
      code: "capability_unavailable",
      message: capability.message,
      status: "unavailable"
    };
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(settingsJson) as Record<string, unknown>;
  } catch {
    return {
      code: "invalid_destination_settings",
      message: "The saved destination settings are invalid.",
      status: "failed_permanent"
    };
  }
  if (
    platform === "youtube" &&
    capability.mode === "private_only" &&
    settings.privacyStatus !== "private"
  ) {
    return {
      code: "youtube_private_only",
      message:
        "YouTube publishing is restricted to private visibility until audit approval.",
      status: "failed_permanent"
    };
  }
  if (
    platform === "tiktok" &&
    capability.mode === "private_only" &&
    settings.privacyLevel !== "SELF_ONLY"
  ) {
    return {
      code: "tiktok_private_only",
      message:
        "TikTok publishing is restricted to private visibility until audit approval.",
      status: "failed_permanent"
    };
  }
  return null;
};

const failureState = (
  error: unknown
): {
  code: string;
  message: string;
  stage: string;
  status: DestinationStatus;
} => {
  if (error instanceof ProviderError) {
    if (error.outcomeUnknown) {
      return {
        code: error.code,
        message: error.message,
        stage: "reconciliation_required",
        status: "reconciliation_required"
      };
    }
    if (error.code === "reauth_required") {
      return {
        code: error.code,
        message: error.message,
        stage: "reauth_required",
        status: "reauth_required"
      };
    }
    if (error.code === "capability_unavailable") {
      return {
        code: error.code,
        message: error.message,
        stage: "unavailable",
        status: "unavailable"
      };
    }
    return {
      code: error.code,
      message: error.message,
      stage: error.retryable ? "retry_exhausted" : "failed",
      status: "failed_permanent"
    };
  }

  return {
    code: "workflow_unhandled_error",
    message: "The provider outcome could not be determined safely.",
    stage: "reconciliation_required",
    status: "reconciliation_required"
  };
};

const publishForPlatform = async (
  platform: Platform,
  runtime: PublishRuntime
): Promise<void> => {
  if (platform === "facebook") {
    await publishFacebook(runtime);
    return;
  }
  if (platform === "instagram") {
    await publishInstagram(runtime);
    return;
  }
  if (platform === "youtube") {
    await publishYoutube(runtime);
    return;
  }
  await publishTikTok(runtime);
};

export class PublishWorkflow extends WorkflowEntrypoint<
  Bindings,
  PublishWorkflowParams
> {
  override async run(
    event: Readonly<WorkflowEvent<PublishWorkflowParams>>,
    step: WorkflowStep
  ): Promise<void> {
    const { attemptNumber, destinationId } = event.payload;
    if (
      !Number.isInteger(attemptNumber) ||
      attemptNumber < 1 ||
      typeof destinationId !== "string" ||
      destinationId.length === 0
    ) {
      throw new NonRetryableError(
        "The publication workflow payload is invalid."
      );
    }

    const dispatch = await step.do(
      "claim-publish-attempt",
      safeStep,
      async () => {
        const context = await loadPublishContext(this.env, destinationId);
        if (context?.destination.attemptNumber !== attemptNumber) {
          throw new NonRetryableError(
            "The publication attempt is no longer current."
          );
        }
        if (terminalStatuses.has(context.destination.status)) {
          return {
            platform: context.destination.platform,
            reconcileOnly: context.destination.stage === "reconcile_only",
            stopped: true
          } satisfies DispatchState;
        }

        const reconcileOnly = context.destination.stage === "reconcile_only";
        const hasRemoteState =
          context.destination.remoteSessionId !== null ||
          context.destination.remotePostId !== null ||
          context.destination.remoteUploadUrlEncrypted !== null;
        const gate = reconcileOnly
          ? null
          : capabilityFailure(
              this.env,
              context.destination.platform,
              context.destination.settingsJson
            );
        if (gate !== null) {
          const status = hasRemoteState
            ? "reconciliation_required"
            : gate.status;
          await finishDestination(this.env, {
            attemptNumber,
            destinationId,
            errorCode: gate.code,
            errorMessage: gate.message,
            stage:
              status === "reconciliation_required"
                ? "reconciliation_required"
                : status === "unavailable"
                  ? "unavailable"
                  : "failed",
            status
          });
          return {
            platform: context.destination.platform,
            reconcileOnly,
            stopped: true
          } satisfies DispatchState;
        }

        await updateDestination(this.env, destinationId, attemptNumber, {
          lastErrorCode: null,
          lastErrorMessage: null,
          nextPollAt: null,
          outcomeUnknown: false,
          status: "starting"
        });
        return {
          platform: context.destination.platform,
          reconcileOnly,
          stopped: false
        } satisfies DispatchState;
      }
    );

    if (dispatch.stopped) {
      return;
    }

    const runtime: PublishRuntime = {
      attemptNumber,
      bindings: this.env,
      destinationId,
      reconcileOnly: dispatch.reconcileOnly,
      step
    };
    try {
      await publishForPlatform(dispatch.platform, runtime);
      await step.do("verify-terminal-destination-state", safeStep, async () => {
        const context = await loadPublishContext(this.env, destinationId);
        if (context?.destination.attemptNumber !== attemptNumber) {
          throw new NonRetryableError(
            "The publication attempt is no longer current."
          );
        }
        if (
          context.destination.status !== "published" &&
          context.destination.status !== "awaiting_user_action"
        ) {
          throw new ProviderError({
            code: "provider_completion_unconfirmed",
            message:
              "The provider did not leave the destination in a confirmed state.",
            outcomeUnknown: true
          });
        }
        return { status: context.destination.status };
      });
    } catch (error) {
      if (error instanceof NonRetryableError) {
        throw error;
      }
      const failure = failureState(error);
      await step.do("persist-terminal-publish-failure", safeStep, async () => {
        const context = await loadPublishContext(this.env, destinationId);
        if (
          context?.destination.attemptNumber !== attemptNumber ||
          context.destination.status === "cancelled" ||
          context.destination.status === "published"
        ) {
          return { persisted: false };
        }
        if (failure.status === "reauth_required") {
          await createDb(this.env.DB)
            .update(socialConnections)
            .set({
              lastErrorCode: failure.code,
              lastErrorMessage: "Reconnect this account to continue publishing.",
              status: "reauth_required",
              updatedAt: Date.now()
            })
            .where(eq(socialConnections.id, context.connection.id));
        }
        await finishDestination(this.env, {
          attemptNumber,
          destinationId,
          errorCode: failure.code,
          errorMessage: failure.message,
          stage: failure.stage,
          status: failure.status
        });
        return { persisted: true };
      });
      throw new NonRetryableError(failure.message, failure.code);
    }
  }
}
