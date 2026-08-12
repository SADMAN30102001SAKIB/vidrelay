import { and, eq, gt, isNull } from "drizzle-orm";

import type { Bindings } from "../env";
import { requireSecret } from "../env";
import type { Database } from "../db/client";
import { mediaLeases } from "../db/schema";
import { constantTimeEqual, hmacBase64Url } from "./crypto";

type LeasePurpose = "facebook" | "instagram" | "tiktok" | "preview";

const signatureFor = (bindings: Bindings, leaseId: string): Promise<string> =>
  hmacBase64Url(
    requireSecret(bindings.MEDIA_LEASE_SECRET, "MEDIA_LEASE_SECRET"),
    "media-lease:" + leaseId
  );

export const createMediaLease = async (
  db: Database,
  bindings: Bindings,
  input: {
    destinationId: string | null;
    purpose: LeasePurpose;
    ttlMs: number;
    uploadId: string;
  }
): Promise<{ expiresAt: number; id: string; url: string }> => {
  const now = Date.now();
  const conditions = [
    eq(mediaLeases.uploadId, input.uploadId),
    eq(mediaLeases.purpose, input.purpose),
    gt(mediaLeases.expiresAt, now + 5 * 60 * 1000),
    isNull(mediaLeases.revokedAt)
  ];
  conditions.push(
    input.destinationId === null
      ? isNull(mediaLeases.destinationId)
      : eq(mediaLeases.destinationId, input.destinationId)
  );
  const [existing] = await db
    .select()
    .from(mediaLeases)
    .where(and(...conditions))
    .limit(1);
  const id = existing?.id ?? crypto.randomUUID();
  const expiresAt = existing?.expiresAt ?? now + input.ttlMs;
  if (existing === undefined) {
    await db.insert(mediaLeases).values({
      createdAt: now,
      destinationId: input.destinationId,
      expiresAt,
      id,
      purpose: input.purpose,
      uploadId: input.uploadId
    });
  }

  const signature = await signatureFor(bindings, id);
  return {
    expiresAt,
    id,
    url: new URL(
      "/media/provider/" + id + "." + signature + "/video.mp4",
      bindings.PUBLIC_API_ORIGIN
    ).toString()
  };
};

export const verifyMediaLeaseSignature = async (
  bindings: Bindings,
  leaseId: string,
  signature: string
): Promise<boolean> =>
  constantTimeEqual(signature, await signatureFor(bindings, leaseId));
