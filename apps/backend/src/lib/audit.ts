import type { Database } from "../db/client";
import { auditEvents } from "../db/schema";

export const writeAuditEvent = async (
  db: Database,
  input: {
    action: string;
    actorUserId?: string;
    entityId?: string;
    entityType: string;
    metadata?: Record<string, unknown>;
    workspaceId?: string;
  }
): Promise<void> => {
  await db.insert(auditEvents).values({
    action: input.action,
    actorUserId: input.actorUserId,
    entityId: input.entityId,
    entityType: input.entityType,
    id: crypto.randomUUID(),
    metadataJson: JSON.stringify(input.metadata ?? {}),
    workspaceId: input.workspaceId
  });
};
