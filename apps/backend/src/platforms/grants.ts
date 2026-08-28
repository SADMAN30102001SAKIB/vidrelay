import { and, eq, inArray, ne, sql } from "drizzle-orm";

import type { Bindings } from "../env";
import type { Database } from "../db/client";
import type { socialConnections } from "../db/schema";
import { socialConnections as connections } from "../db/schema";
import { sha256Base64Url } from "../lib/crypto";
import { decodeCredentials, type StoredCredentials } from "./credentials";

type ConnectionRow = typeof socialConnections.$inferSelect;
export type ActiveGrantSiblingState = "none" | "shared" | "unknown";
export type GrantRelationship = "different" | "shared" | "unknown";

const metadataString = (metadataJson: string, key: string): string | null => {
  try {
    const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
    const value = metadata[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

const knownGrantKey = (row: ConnectionRow): string | null => {
  if (row.provider === "facebook") {
    const grantUserId = metadataString(row.metadataJson, "grantUserId");
    return grantUserId === null ? null : "facebook:" + grantUserId;
  }
  if (row.provider === "youtube") {
    const grantSubject = metadataString(row.metadataJson, "grantSubject");
    return grantSubject === null ? null : "youtube:" + grantSubject;
  }
  return row.provider + ":" + row.remoteAccountId;
};

export const providerGrantKey = async (
  bindings: Bindings,
  row: ConnectionRow,
  credentials?: StoredCredentials
): Promise<string> => {
  const known = knownGrantKey(row);
  if (known !== null) {
    return known;
  }
  if (row.provider === "facebook") {
    const decoded =
      credentials ??
      (await decodeCredentials(bindings, row.credentialsEncrypted));
    if (decoded.userAccessToken !== null) {
      return (
        "facebook-token:" + (await sha256Base64Url(decoded.userAccessToken))
      );
    }
  }
  if (row.provider === "youtube") {
    const decoded =
      credentials ??
      (await decodeCredentials(bindings, row.credentialsEncrypted));
    return (
      "youtube-token:" +
      (await sha256Base64Url(decoded.refreshToken ?? decoded.accessToken))
    );
  }
  return row.provider + ":unknown";
};

const knownGrantRelationship = (
  row: ConnectionRow,
  sibling: ConnectionRow
): GrantRelationship | null => {
  const rowKnown = knownGrantKey(row);
  const siblingKnown = knownGrantKey(sibling);
  if (rowKnown === null || siblingKnown === null) {
    return null;
  }
  return rowKnown === siblingKnown ? "shared" : "different";
};

const credentialGrantRelationship = (
  row: ConnectionRow,
  credentials: StoredCredentials,
  siblingCredentials: StoredCredentials
): GrantRelationship => {
  if (row.provider === "facebook") {
    const userAccessToken = credentials.userAccessToken;
    return userAccessToken !== null &&
      siblingCredentials.userAccessToken === userAccessToken
      ? "shared"
      : "unknown";
  }
  const token = credentials.refreshToken ?? credentials.accessToken;
  const siblingToken =
    siblingCredentials.refreshToken ?? siblingCredentials.accessToken;
  return token === siblingToken ? "shared" : "unknown";
};

export const grantRelationship = async (
  bindings: Bindings,
  row: ConnectionRow,
  sibling: ConnectionRow,
  credentials: StoredCredentials
): Promise<GrantRelationship> => {
  const knownRelationship = knownGrantRelationship(row, sibling);
  if (knownRelationship !== null) {
    return knownRelationship;
  }
  if (row.provider === "instagram" || row.provider === "tiktok") {
    return row.remoteAccountId === sibling.remoteAccountId
      ? "shared"
      : "different";
  }
  let siblingCredentials: StoredCredentials;
  try {
    siblingCredentials = await decodeCredentials(
      bindings,
      sibling.credentialsEncrypted
    );
  } catch {
    return "unknown";
  }
  return credentialGrantRelationship(row, credentials, siblingCredentials);
};

export const activeGrantSiblingState = async (
  db: Database,
  bindings: Bindings,
  row: ConnectionRow,
  credentials: StoredCredentials,
  excludingWorkspaceId?: string
): Promise<ActiveGrantSiblingState> => {
  const candidates = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.provider, row.provider),
        ne(connections.id, row.id),
        inArray(connections.status, [
          "connected",
          "limited",
          "reauth_required"
        ]),
        excludingWorkspaceId === undefined
          ? undefined
          : sql`${connections.workspaceId} <> ${excludingWorkspaceId}`,
        sql`(${connections.lastErrorCode} IS NULL OR ${connections.lastErrorCode} = 'provider_revoke_failed' OR (${connections.lastErrorCode} NOT LIKE 'disconnecting:%' AND ${connections.lastErrorCode} NOT LIKE 'account_deletion_revoke_started%' AND ${connections.lastErrorCode} <> 'account_deletion_revoke_completed'))`,
        sql`EXISTS (SELECT 1 FROM workspaces INNER JOIN users ON users.id = ${connections.connectedByUserId} WHERE workspaces.id = ${connections.workspaceId} AND workspaces.status = 'active' AND users.status = 'active')`
      )
    );
  let hasUnknownSibling = false;
  for (const sibling of candidates) {
    const relationship = await grantRelationship(
      bindings,
      row,
      sibling,
      credentials
    );
    if (relationship === "shared") {
      return "shared";
    }
    if (relationship === "unknown") {
      hasUnknownSibling = true;
    }
  }
  return hasUnknownSibling ? "unknown" : "none";
};
