import { and, asc, eq, isNull } from "drizzle-orm";

import type { Bindings, PublishWorkflowParams } from "../env";
import { createDb } from "../db/client";
import { outboxEvents } from "../db/schema";
import { safeLog } from "../lib/safe-logger";

export const workflowInstanceId = (
  destinationId: string,
  attemptNumber: number
): string => "pub-" + destinationId + "-a" + String(attemptNumber);

export const dispatchOutbox = async (bindings: Bindings): Promise<number> => {
  const db = createDb(bindings.DB);
  const events = await db
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.eventType, "publish_destination"),
        isNull(outboxEvents.dispatchedAt)
      )
    )
    .orderBy(asc(outboxEvents.createdAt))
    .limit(20);
  if (events.length === 0) {
    return 0;
  }

  const instances = events.map(event => ({
    id: event.id,
    params: {
      attemptNumber: event.attemptNumber,
      destinationId: event.aggregateId
    } satisfies PublishWorkflowParams
  }));

  try {
    await bindings.PUBLISH_WORKFLOW.createBatch(instances);
    const now = Date.now();
    await bindings.DB.batch(
      events.flatMap(event => [
        bindings.DB.prepare(
          "UPDATE outbox_events SET dispatched_at = ?, last_error = NULL WHERE id = ?"
        ).bind(now, event.id),
        bindings.DB.prepare(
          "UPDATE publish_destinations SET workflow_instance_id = ?, updated_at = ? WHERE id = ? AND attempt_number = ?"
        ).bind(event.id, now, event.aggregateId, event.attemptNumber)
      ])
    );
    return events.length;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 500)
        : "Workflow dispatch failed.";
    await bindings.DB.batch(
      events.map(event =>
        bindings.DB.prepare(
          "UPDATE outbox_events SET last_error = ? WHERE id = ?"
        ).bind(message, event.id)
      )
    );
    safeLog("error", "outbox.dispatch_failed", {
      count: events.length,
      error: message
    });
    return 0;
  }
};
