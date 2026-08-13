import type { DestinationStatus, PostStatus } from "@vidrelay/shared";
import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";

import type { Bindings } from "../env";
import { createDb } from "../db/client";
import {
  posts,
  publishAttempts,
  publishDestinations,
  socialConnections,
  uploads
} from "../db/schema";

export const loadPublishContext = async (
  bindings: Bindings,
  destinationId: string
) => {
  const [row] = await createDb(bindings.DB)
    .select({
      connection: socialConnections,
      destination: publishDestinations,
      post: posts,
      upload: uploads
    })
    .from(publishDestinations)
    .innerJoin(posts, eq(posts.id, publishDestinations.postId))
    .innerJoin(uploads, eq(uploads.id, posts.uploadId))
    .innerJoin(
      socialConnections,
      eq(socialConnections.id, publishDestinations.connectionId)
    )
    .where(eq(publishDestinations.id, destinationId))
    .limit(1);
  return row ?? null;
};

export type PublishContext = NonNullable<
  Awaited<ReturnType<typeof loadPublishContext>>
>;

const mutableDestinationStatuses: DestinationStatus[] = [
  "queued",
  "starting",
  "transferring",
  "processing",
  "publishing",
  "retry_scheduled"
];

export const updateDestination = async (
  bindings: Bindings,
  destinationId: string,
  attemptNumber: number,
  patch: Partial<typeof publishDestinations.$inferInsert>
): Promise<boolean> => {
  const now = Date.now();
  const transitionToken = crypto.randomUUID();
  const db = createDb(bindings.DB);
  const allowedCurrentStatus =
    patch.status === "published"
      ? ne(publishDestinations.status, "cancelled")
      : inArray(publishDestinations.status, mutableDestinationStatuses);
  const [updated] = await db.batch([
    db
      .update(publishDestinations)
      .set({ ...patch, transitionToken, updatedAt: now })
      .where(
        and(
          eq(publishDestinations.id, destinationId),
          eq(publishDestinations.attemptNumber, attemptNumber),
          allowedCurrentStatus
        )
      )
      .returning({ id: publishDestinations.id }),
    db
      .update(publishAttempts)
      .set({
        errorCode: patch.lastErrorCode,
        errorMessage: patch.lastErrorMessage,
        remotePostId: patch.remotePostId,
        remoteSessionId: patch.remoteSessionId,
        stage: patch.stage ?? "processing",
        status: patch.status ?? "processing",
        updatedAt: now
      })
      .where(
        and(
          eq(publishAttempts.destinationId, destinationId),
          eq(publishAttempts.attemptNumber, attemptNumber),
          sql`EXISTS (
            SELECT 1 FROM ${publishDestinations}
            WHERE ${publishDestinations.id} = ${destinationId}
              AND ${publishDestinations.attemptNumber} = ${attemptNumber}
              AND ${publishDestinations.transitionToken} = ${transitionToken}
          )`
        )
      ),
    db
      .update(posts)
      .set({ status: "publishing", updatedAt: now })
      .where(
        sql`EXISTS (
          SELECT 1 FROM ${publishDestinations}
          WHERE ${publishDestinations.postId} = ${posts.id}
            AND ${publishDestinations.id} = ${destinationId}
            AND ${publishDestinations.attemptNumber} = ${attemptNumber}
            AND ${publishDestinations.transitionToken} = ${transitionToken}
        )`
      )
  ]);
  if (updated.length === 0) {
    return false;
  }
  return true;
};

export const finishDestination = async (
  bindings: Bindings,
  input: {
    attemptNumber: number;
    destinationId: string;
    errorCode?: string | null | undefined;
    errorMessage?: string | null | undefined;
    providerPostId?: string | undefined;
    providerUrl?: string | undefined;
    authoritative?: boolean | undefined;
    expectedUpdatedAt?: number | undefined;
    stage: string;
    status: DestinationStatus;
  }
): Promise<boolean> => {
  const now = Date.now();
  const transitionToken = crypto.randomUUID();
  const destinationPatch: Partial<typeof publishDestinations.$inferInsert> = {
    lastErrorCode: input.errorCode ?? null,
    lastErrorMessage: input.errorMessage ?? null,
    nextPollAt: null,
    outcomeUnknown: input.status === "reconciliation_required",
    publishedAt: input.status === "published" ? now : null,
    stage: input.stage,
    status: input.status,
    transitionToken,
    updatedAt: now
  };
  if (input.providerPostId !== undefined) {
    destinationPatch.remotePostId = input.providerPostId;
  }
  if (input.providerUrl !== undefined) {
    destinationPatch.remoteUrl = input.providerUrl;
  }

  const db = createDb(bindings.DB);
  const allowedCurrentStatus =
    input.status === "published"
      ? ne(publishDestinations.status, "cancelled")
      : input.authoritative === true
        ? and(
            ne(publishDestinations.status, "cancelled"),
            ne(publishDestinations.status, "published")
          )
        : inArray(publishDestinations.status, mutableDestinationStatuses);
  const [updated] = await db.batch([
    db
      .update(publishDestinations)
      .set(destinationPatch)
      .where(
        and(
          eq(publishDestinations.id, input.destinationId),
          eq(publishDestinations.attemptNumber, input.attemptNumber),
          allowedCurrentStatus,
          input.expectedUpdatedAt === undefined
            ? undefined
            : eq(publishDestinations.updatedAt, input.expectedUpdatedAt)
        )
      )
      .returning({ postId: publishDestinations.postId }),
    db
      .update(publishAttempts)
      .set({
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        finishedAt: now,
        remotePostId: input.providerPostId,
        stage: input.stage,
        status: input.status,
        updatedAt: now
      })
      .where(
        and(
          eq(publishAttempts.destinationId, input.destinationId),
          eq(publishAttempts.attemptNumber, input.attemptNumber),
          sql`EXISTS (
            SELECT 1 FROM ${publishDestinations}
            WHERE ${publishDestinations.id} = ${input.destinationId}
              AND ${publishDestinations.attemptNumber} = ${input.attemptNumber}
              AND ${publishDestinations.transitionToken} = ${transitionToken}
          )`
        )
      )
  ]);
  const [destination] = updated;
  const postId =
    destination?.postId ??
    (
      await db
        .select({ postId: publishDestinations.postId })
        .from(publishDestinations)
        .where(
          and(
            eq(publishDestinations.id, input.destinationId),
            eq(publishDestinations.attemptNumber, input.attemptNumber)
          )
        )
        .limit(1)
    )[0]?.postId;
  if (postId !== undefined) {
    await recomputePostStatus(bindings, postId);
  }
  return destination !== undefined;
};

export const recomputePostStatus = async (
  bindings: Bindings,
  postId: string
): Promise<PostStatus> => {
  const db = createDb(bindings.DB);
  const [updated] = await db
    .update(posts)
    .set({
      status: sql<PostStatus>`CASE
        WHEN EXISTS (SELECT 1 FROM ${publishDestinations} WHERE ${publishDestinations.postId} = ${posts.id})
          AND NOT EXISTS (SELECT 1 FROM ${publishDestinations} WHERE ${publishDestinations.postId} = ${posts.id} AND ${publishDestinations.status} <> 'published')
          THEN 'published'
        WHEN EXISTS (SELECT 1 FROM ${publishDestinations} WHERE ${publishDestinations.postId} = ${posts.id} AND ${publishDestinations.status} IN ('queued', 'starting', 'transferring', 'processing', 'publishing', 'retry_scheduled'))
          THEN 'publishing'
        WHEN EXISTS (SELECT 1 FROM ${publishDestinations} WHERE ${publishDestinations.postId} = ${posts.id} AND ${publishDestinations.status} = 'published')
          THEN 'partial_success'
        WHEN EXISTS (SELECT 1 FROM ${publishDestinations} WHERE ${publishDestinations.postId} = ${posts.id})
          AND NOT EXISTS (SELECT 1 FROM ${publishDestinations} WHERE ${publishDestinations.postId} = ${posts.id} AND ${publishDestinations.status} <> 'cancelled')
          THEN 'cancelled'
        ELSE 'failed'
      END`,
      updatedAt: Date.now()
    })
    .where(eq(posts.id, postId))
    .returning({ status: posts.status });
  return updated?.status ?? "failed";
};

export const recoverStaleDestinations = async (
  bindings: Bindings
): Promise<number> => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const rows = await createDb(bindings.DB)
    .select()
    .from(publishDestinations)
    .where(
      and(
        inArray(publishDestinations.status, mutableDestinationStatuses),
        lt(publishDestinations.updatedAt, cutoff)
      )
    )
    .limit(20);
  let recovered = 0;
  for (const row of rows) {
    const hasRemoteState =
      row.outcomeUnknown ||
      row.stage === "provider_commit_started" ||
      row.remoteSessionId !== null ||
      row.remotePostId !== null ||
      row.remoteUploadUrlEncrypted !== null;
    const status: DestinationStatus = hasRemoteState
      ? "reconciliation_required"
      : "failed_permanent";
    const changed = await finishDestination(bindings, {
      attemptNumber: row.attemptNumber,
      destinationId: row.id,
      errorCode: "workflow_stale",
      errorMessage: hasRemoteState
        ? "Publishing stopped without a terminal result. Reconcile the provider outcome."
        : "Publishing stopped before a provider upload was created. Retry is available.",
      stage: hasRemoteState
        ? "reconciliation_required"
        : "stale_workflow_failed",
      expectedUpdatedAt: row.updatedAt,
      status
    });
    if (changed) {
      recovered += 1;
    }
  }
  return recovered;
};
