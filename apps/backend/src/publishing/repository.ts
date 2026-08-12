import type { DestinationStatus, PostStatus } from "@vidrelay/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import type { Bindings } from "../env";
import { createDb } from "../db/client";
import {
  posts,
  publishAttempts,
  publishDestinations,
  socialConnections,
  uploads
} from "../db/schema";

export const loadPublishContext = async (bindings: Bindings, destinationId: string) => {
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

export type PublishContext = NonNullable<Awaited<ReturnType<typeof loadPublishContext>>>;

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
      : inArray(publishDestinations.status, mutableDestinationStatuses);
  const [updated] = await db.batch([
    db
      .update(publishDestinations)
      .set(destinationPatch)
      .where(
        and(
          eq(publishDestinations.id, input.destinationId),
          eq(publishDestinations.attemptNumber, input.attemptNumber),
          allowedCurrentStatus
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

const activeStatuses = new Set<DestinationStatus>(mutableDestinationStatuses);

export const recomputePostStatus = async (
  bindings: Bindings,
  postId: string
): Promise<PostStatus> => {
  const db = createDb(bindings.DB);
  const rows = await db
    .select({ status: publishDestinations.status })
    .from(publishDestinations)
    .where(eq(publishDestinations.postId, postId));
  const statuses = rows.map(row => row.status);

  let status: PostStatus;
  if (statuses.length > 0 && statuses.every(value => value === "published")) {
    status = "published";
  } else if (statuses.some(value => activeStatuses.has(value))) {
    status = "publishing";
  } else if (statuses.some(value => value === "published")) {
    status = "partial_success";
  } else if (statuses.length > 0 && statuses.every(value => value === "cancelled")) {
    status = "cancelled";
  } else {
    status = "failed";
  }

  await db
    .update(posts)
    .set({ status, updatedAt: Date.now() })
    .where(eq(posts.id, postId));
  return status;
};
