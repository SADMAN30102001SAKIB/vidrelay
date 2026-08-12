import type {
  CapabilityMode,
  ConnectionStatus,
  DestinationStatus,
  PostStatus
} from "@vidrelay/shared";

export type StatusTone = "danger" | "info" | "neutral" | "success" | "warning";

export interface StatusView {
  label: string;
  tone: StatusTone;
}

const readable = (value: string): string =>
  value
    .split("_")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

const postTones: Record<PostStatus, StatusTone> = {
  cancelled: "neutral",
  draft: "neutral",
  failed: "danger",
  partial_success: "warning",
  published: "success",
  publishing: "info",
  queued: "info",
  ready: "info"
};

const destinationTones: Record<DestinationStatus, StatusTone> = {
  awaiting_user_action: "warning",
  blocked: "danger",
  cancelled: "neutral",
  failed_permanent: "danger",
  processing: "info",
  published: "success",
  publishing: "info",
  queued: "info",
  reauth_required: "warning",
  reconciliation_required: "warning",
  retry_scheduled: "info",
  starting: "info",
  transferring: "info",
  unavailable: "danger"
};

const connectionTones: Record<ConnectionStatus, StatusTone> = {
  connected: "success",
  disconnected: "neutral",
  limited: "warning",
  reauth_required: "warning"
};

const capabilityTones: Record<CapabilityMode, StatusTone> = {
  development_only: "warning",
  direct_publish: "success",
  disabled: "neutral",
  inbox_only: "warning",
  private_only: "info",
  review_pending: "warning"
};

export const postStatusView = (status: PostStatus): StatusView => ({
  label: readable(status),
  tone: postTones[status]
});

export const destinationStatusView = (
  status: DestinationStatus
): StatusView => ({
  label: readable(status),
  tone: destinationTones[status]
});

export const connectionStatusView = (status: ConnectionStatus): StatusView => ({
  label: readable(status),
  tone: connectionTones[status]
});

export const capabilityStatusView = (mode: CapabilityMode): StatusView => ({
  label: readable(mode),
  tone: capabilityTones[mode]
});

export const destinationIsActive = (status: DestinationStatus): boolean =>
  [
    "queued",
    "starting",
    "transferring",
    "processing",
    "publishing",
    "retry_scheduled"
  ].includes(status);
