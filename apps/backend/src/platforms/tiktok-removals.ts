import type { Bindings } from "../env";

export const latestTiktokRemoval = async (
  bindings: Bindings,
  openId: string
): Promise<number | null> => {
  const prefix = "authorization.removed:" + openId + ":";
  const row = await bindings.DB.prepare(
    "SELECT MAX(CAST(substr(provider_event_id, length(?) + 1) AS INTEGER)) AS event_seconds FROM webhook_events WHERE provider = 'tiktok' AND provider_event_id IS NOT NULL AND instr(provider_event_id, ?) = 1 AND status IN ('received', 'processed', 'failed')"
  )
    .bind(prefix, prefix)
    .first<{ event_seconds: number | null }>();
  const seconds = row?.event_seconds;
  return typeof seconds === "number" && Number.isSafeInteger(seconds)
    ? seconds * 1000
    : null;
};
