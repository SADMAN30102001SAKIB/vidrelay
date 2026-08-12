import { and, eq, gt } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

import type { AppEnv, AuthContext } from "../env";
import { createDb } from "../db/client";
import { memberships, sessions, users, workspaces } from "../db/schema";
import { readCookie, sessionCookieName } from "../lib/cookies";
import { sha256Base64Url } from "../lib/crypto";
import { AppError } from "../lib/errors";

const resolveAuth = async (
  request: Request,
  database: D1Database
): Promise<AuthContext | null> => {
  const token = readCookie(request, sessionCookieName);
  if (token === null || token.length < 32) {
    return null;
  }

  const sessionHash = await sha256Base64Url(token);
  const now = Date.now();
  const db = createDb(database);
  const [row] = await db
    .select({
      expiresAt: sessions.expiresAt,
      role: users.role,
      sessionHash: sessions.id,
      sessionLastSeenAt: sessions.lastSeenAt,
      userId: users.id,
      userStatus: users.status,
      workspaceId: workspaces.id,
      workspaceStatus: workspaces.status
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      and(
        eq(sessions.id, sessionHash),
        gt(sessions.expiresAt, now),
        eq(users.status, "active"),
        eq(workspaces.status, "active")
      )
    )
    .limit(1);

  if (row === undefined) {
    return null;
  }

  if (now - row.sessionLastSeenAt > 15 * 60 * 1000) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, sessionHash));
  }

  return {
    role: row.role,
    sessionHash: row.sessionHash,
    userId: row.userId,
    workspaceId: row.workspaceId
  };
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (context, next) => {
  const auth = await resolveAuth(context.req.raw, context.env.DB);
  if (auth === null) {
    throw new AppError(401, "authentication_required", "Please sign in to continue.");
  }

  context.set("auth", auth);
  await next();
};
