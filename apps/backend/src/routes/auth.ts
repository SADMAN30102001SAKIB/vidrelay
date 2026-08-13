import {
  changePasswordSchema,
  loginSchema,
  provisionCustomerSchema,
  registerSchema,
  updateProfileSchema,
  type User
} from "@vidrelay/shared";
import { and, eq, like, ne, sql } from "drizzle-orm";
import { Hono } from "hono";

import type { AppEnv, AuthContext } from "../env";
import { createDb, type Database } from "../db/client";
import {
  auditEvents,
  authAttempts,
  memberships,
  sessions,
  users,
  workspaces
} from "../db/schema";
import { writeAuditEvent } from "../lib/audit";
import { createSessionCookie, deleteSessionCookie } from "../lib/cookies";
import {
  constantTimeEqual,
  hashPassword,
  hmacBase64Url,
  randomToken,
  sha256Base64Url,
  verifyPassword
} from "../lib/crypto";
import { AppError } from "../lib/errors";
import { parseJson } from "../lib/json";
import { requireAuth } from "../middleware/auth";

const sessionLifetimeSeconds = 30 * 24 * 60 * 60;
const attemptWindowMs = 15 * 60 * 1000;
const maximumAccountAttempts = 10;
const maximumIpAttempts = 30;

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const validTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
};

const slugify = (name: string): string => {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return (
    (base.length > 0 ? base : "workspace") + "-" + randomToken(5).toLowerCase()
  );
};

const clientAddress = (request: Request): string =>
  request.headers.get("CF-Connecting-IP") ?? "unknown";

const rateLimitKey = async (
  kind: string,
  email: string,
  request: Request,
  secret: string | undefined
): Promise<string> => {
  const material = [kind, clientAddress(request), email].join(":");
  return secret === undefined || secret.length === 0
    ? await sha256Base64Url(material)
    : await hmacBase64Url(secret, material);
};

const consumeAttempt = async (
  database: D1Database,
  key: string,
  maximumAttempts: number
): Promise<void> => {
  const now = Date.now();
  const row = await database
    .prepare(
      "INSERT INTO auth_attempts (key, attempts, window_started_at, blocked_until, updated_at) VALUES (?, 1, ?, NULL, ?) ON CONFLICT(key) DO UPDATE SET attempts = CASE WHEN ? - window_started_at < ? THEN attempts + 1 ELSE 1 END, window_started_at = CASE WHEN ? - window_started_at < ? THEN window_started_at ELSE ? END, blocked_until = CASE WHEN ? - window_started_at < ? AND attempts + 1 >= ? THEN ? + ? ELSE NULL END, updated_at = ? RETURNING blocked_until"
    )
    .bind(
      key,
      now,
      now,
      now,
      attemptWindowMs,
      now,
      attemptWindowMs,
      now,
      now,
      attemptWindowMs,
      maximumAttempts,
      now,
      attemptWindowMs,
      now
    )
    .first<{ blocked_until: number | null }>();
  if (row?.blocked_until !== null && row?.blocked_until !== undefined) {
    throw new AppError(
      429,
      "too_many_attempts",
      "Too many sign-in attempts. Please wait before trying again."
    );
  }
};

const clearFailedAttempts = async (
  db: Database,
  key: string
): Promise<void> => {
  await db.delete(authAttempts).where(eq(authAttempts.key, key));
};

const sessionIpHash = async (
  request: Request,
  secret: string | undefined
): Promise<string | null> => {
  if (secret === undefined || secret.length === 0) {
    return null;
  }

  return await hmacBase64Url(secret, clientAddress(request));
};

const createSession = async (
  db: Database,
  request: Request,
  userId: string,
  auditHashSecret: string | undefined
): Promise<{ expiresAt: number; token: string }> => {
  const token = randomToken();
  const id = await sha256Base64Url(token);
  const now = Date.now();
  const expiresAt = now + sessionLifetimeSeconds * 1000;

  await db.insert(sessions).values({
    createdAt: now,
    expiresAt,
    id,
    ipHash: await sessionIpHash(request, auditHashSecret),
    lastSeenAt: now,
    userAgent: request.headers.get("User-Agent")?.slice(0, 255) ?? null,
    userId
  });

  return { expiresAt, token };
};

const loadUser = async (
  db: Database,
  userId: string,
  workspaceId?: string
): Promise<User> => {
  const rows = await db
    .select({
      createdAt: users.createdAt,
      email: users.email,
      id: users.id,
      name: users.name,
      role: users.role,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      workspaceTimezone: workspaces.timezone
    })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      workspaceId === undefined
        ? eq(users.id, userId)
        : and(eq(users.id, userId), eq(workspaces.id, workspaceId))
    )
    .limit(1);
  const row = rows[0];

  if (row === undefined) {
    throw new AppError(
      404,
      "user_not_found",
      "The account could not be found."
    );
  }

  return {
    createdAt: row.createdAt,
    email: row.email,
    id: row.id,
    name: row.name,
    role: row.role,
    workspace: {
      id: row.workspaceId,
      name: row.workspaceName,
      timezone: row.workspaceTimezone
    }
  };
};

const auth = (context: { get: (key: "auth") => AuthContext }): AuthContext =>
  context.get("auth");

export const authRoutes = new Hono<AppEnv>();

const createCustomerAccount = async (
  database: D1Database,
  input: {
    email: string;
    name: string;
    password: string;
    timezone: string;
    workspaceName: string;
  },
  audit?: {
    actorUserId: string;
    workspaceId: string;
  }
): Promise<{ userId: string; workspaceId: string }> => {
  const email = normalizeEmail(input.email);
  const now = Date.now();
  const userId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const passwordHash = await hashPassword(input.password);
  const db = createDb(database);
  await db.batch([
    db.insert(users).values({
      createdAt: now,
      email,
      id: userId,
      name: input.name,
      passwordHash,
      role: "customer",
      status: "active",
      updatedAt: now
    }),
    db.insert(workspaces).values({
      createdAt: now,
      id: workspaceId,
      name: input.workspaceName,
      slug: slugify(input.workspaceName),
      status: "active",
      timezone: input.timezone,
      updatedAt: now
    }),
    db.insert(memberships).values({
      createdAt: now,
      role: "owner",
      userId,
      workspaceId
    }),
    db.insert(auditEvents).values({
      action: audit === undefined ? "account.registered" : "account.provisioned",
      actorUserId: audit?.actorUserId ?? userId,
      entityId: userId,
      entityType: "user",
      id: crypto.randomUUID(),
      metadataJson: JSON.stringify(
        audit === undefined ? {} : { workspaceId }
      ),
      workspaceId: audit?.workspaceId ?? workspaceId
    })
  ]);
  return { userId, workspaceId };
};

authRoutes.post("/register", async context => {
  const bootstrapToken = context.req.header("X-VidRelay-Bootstrap");
  const configuredBootstrapToken = context.env.BOOTSTRAP_SIGNUP_TOKEN;
  const bootstrapRequested = bootstrapToken !== undefined;
  const bootstrapAuthorized =
    bootstrapRequested &&
    configuredBootstrapToken !== undefined &&
    configuredBootstrapToken.length >= 32 &&
    constantTimeEqual(bootstrapToken, configuredBootstrapToken);
  if (context.env.ALLOW_SIGNUPS !== "true" && !bootstrapAuthorized) {
    throw new AppError(
      403,
      "signups_disabled",
      "New account registration is disabled."
    );
  }

  const input = await parseJson(context, registerSchema);
  if (!validTimezone(input.timezone)) {
    throw new AppError(
      422,
      "invalid_timezone",
      "Choose a valid IANA time zone."
    );
  }

  const email = normalizeEmail(input.email);
  const db = createDb(context.env.DB);
  if (bootstrapAuthorized) {
    const [accountCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(users);
    if (accountCount?.count !== 0) {
      throw new AppError(
        409,
        "bootstrap_already_completed",
        "The initial owner account has already been created."
      );
    }
  }
  const key = await rateLimitKey(
    "register",
    email,
    context.req.raw,
    context.env.AUDIT_HASH_SECRET
  );
  const ipKey = await rateLimitKey(
    "register_ip",
    "*",
    context.req.raw,
    context.env.AUDIT_HASH_SECRET
  );
  await consumeAttempt(context.env.DB, ipKey, maximumIpAttempts);
  await consumeAttempt(context.env.DB, key, maximumAccountAttempts);

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing !== undefined) {
    throw new AppError(
      409,
      "account_exists",
      "An account already exists for this email."
    );
  }

  const now = Date.now();
  let userId = crypto.randomUUID();
  let workspaceId = crypto.randomUUID();
  const passwordHash = await hashPassword(input.password);

  try {
    if (bootstrapAuthorized) {
      const results = await context.env.DB.batch([
        context.env.DB.prepare(
          "INSERT INTO users (id, email, name, password_hash, role, status, created_at, updated_at) SELECT ?, ?, ?, ?, 'operator', 'active', ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)"
        ).bind(userId, email, input.name, passwordHash, now, now),
        context.env.DB.prepare(
          "INSERT INTO workspaces (id, name, slug, timezone, status, created_at, updated_at) SELECT ?, ?, ?, ?, 'active', ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)"
        ).bind(
          workspaceId,
          input.workspaceName,
          slugify(input.workspaceName),
          input.timezone,
          now,
          now,
          userId
        ),
        context.env.DB.prepare(
          "INSERT INTO memberships (user_id, workspace_id, role, created_at) SELECT ?, ?, 'owner', ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?) AND EXISTS (SELECT 1 FROM workspaces WHERE id = ?)"
        ).bind(userId, workspaceId, now, userId, workspaceId),
        context.env.DB.prepare(
          "INSERT INTO audit_events (id, actor_user_id, workspace_id, action, entity_type, entity_id, metadata_json, created_at) SELECT ?, ?, ?, 'account.registered', 'user', ?, '{}', ? WHERE EXISTS (SELECT 1 FROM memberships WHERE user_id = ? AND workspace_id = ?)"
        ).bind(
          crypto.randomUUID(),
          userId,
          workspaceId,
          userId,
          now,
          userId,
          workspaceId
        )
      ]);
      if (
        results[0]?.meta.changes !== 1 ||
        results[1]?.meta.changes !== 1 ||
        results[2]?.meta.changes !== 1 ||
        results[3]?.meta.changes !== 1
      ) {
        throw new Error("The initial owner was created concurrently.");
      }
    } else {
      const created = await createCustomerAccount(context.env.DB, input);
      userId = created.userId;
      workspaceId = created.workspaceId;
    }
  } catch (error) {
    if (
      bootstrapAuthorized &&
      error instanceof Error &&
      error.message === "The initial owner was created concurrently."
    ) {
      throw new AppError(
        409,
        "bootstrap_already_completed",
        "The initial owner account has already been created."
      );
    }
    if (
      error instanceof Error &&
      (error.message.includes("UNIQUE constraint failed: users.email") ||
        error.message.includes("UNIQUE constraint failed: workspaces.slug"))
    ) {
      throw new AppError(
        409,
        "account_exists",
        "An account already exists for this email or workspace name."
      );
    }
    throw error;
  }

  const session = await createSession(
    db,
    context.req.raw,
    userId,
    context.env.AUDIT_HASH_SECRET
  );
  await clearFailedAttempts(db, key);

  context.header(
    "Set-Cookie",
    createSessionCookie(session.token, context.env, sessionLifetimeSeconds)
  );
  return context.json({ user: await loadUser(db, userId, workspaceId) }, 201);
});

authRoutes.post("/provision-customer", requireAuth, async context => {
  const current = auth(context);
  if (current.role !== "operator") {
    throw new AppError(
      403,
      "operator_required",
      "Operator access is required."
    );
  }
  const input = await parseJson(context, provisionCustomerSchema);
  if (!validTimezone(input.timezone)) {
    throw new AppError(
      422,
      "invalid_timezone",
      "Choose a valid IANA time zone."
    );
  }
  const db = createDb(context.env.DB);
  try {
    const created = await createCustomerAccount(context.env.DB, input, {
      actorUserId: current.userId,
      workspaceId: current.workspaceId
    });
    return context.json(
      { user: await loadUser(db, created.userId, created.workspaceId) },
      201
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("UNIQUE constraint failed: users.email") ||
        error.message.includes("UNIQUE constraint failed: workspaces.slug"))
    ) {
      throw new AppError(
        409,
        "account_exists",
        "An account already exists for this email or workspace name."
      );
    }
    throw error;
  }
});

authRoutes.post("/login", async context => {
  const input = await parseJson(context, loginSchema);
  const email = normalizeEmail(input.email);
  const db = createDb(context.env.DB);
  const key = await rateLimitKey(
    "login",
    email,
    context.req.raw,
    context.env.AUDIT_HASH_SECRET
  );
  const ipKey = await rateLimitKey(
    "login_ip",
    "*",
    context.req.raw,
    context.env.AUDIT_HASH_SECRET
  );
  await consumeAttempt(context.env.DB, key, maximumAccountAttempts);

  const [row] = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      status: users.status
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  let valid = false;
  if (row === undefined) {
    await hashPassword(input.password);
  } else {
    valid = await verifyPassword(input.password, row.passwordHash);
  }

  if (!valid || row?.status !== "active") {
    await consumeAttempt(context.env.DB, ipKey, maximumIpAttempts);
    throw new AppError(
      401,
      "invalid_credentials",
      "The email or password is incorrect."
    );
  }

  const session = await createSession(
    db,
    context.req.raw,
    row.id,
    context.env.AUDIT_HASH_SECRET
  );
  const now = Date.now();
  await db
    .update(users)
    .set({ lastLoginAt: now, updatedAt: now })
    .where(eq(users.id, row.id));
  await clearFailedAttempts(db, key);
  const user = await loadUser(db, row.id);
  await writeAuditEvent(db, {
    action: "session.created",
    actorUserId: row.id,
    entityId: row.id,
    entityType: "user",
    workspaceId: user.workspace.id
  });

  context.header(
    "Set-Cookie",
    createSessionCookie(session.token, context.env, sessionLifetimeSeconds)
  );
  return context.json({ user });
});

authRoutes.get("/me", requireAuth, async context => {
  const current = auth(context);
  return context.json({
    user: await loadUser(
      createDb(context.env.DB),
      current.userId,
      current.workspaceId
    )
  });
});

authRoutes.patch("/profile", requireAuth, async context => {
  const current = auth(context);
  const input = await parseJson(context, updateProfileSchema);
  if (!validTimezone(input.timezone)) {
    throw new AppError(
      422,
      "invalid_timezone",
      "Choose a valid IANA time zone."
    );
  }
  const db = createDb(context.env.DB);
  const now = Date.now();
  await db.batch([
    db
      .update(users)
      .set({ name: input.name, updatedAt: now })
      .where(eq(users.id, current.userId)),
    db
      .update(workspaces)
      .set({
        name: input.workspaceName,
        timezone: input.timezone,
        updatedAt: now
      })
      .where(eq(workspaces.id, current.workspaceId))
  ]);
  await writeAuditEvent(db, {
    action: "account.profile_updated",
    actorUserId: current.userId,
    entityId: current.userId,
    entityType: "user",
    workspaceId: current.workspaceId
  });

  return context.json({
    user: await loadUser(db, current.userId, current.workspaceId)
  });
});

authRoutes.post("/logout", requireAuth, async context => {
  const current = auth(context);
  const db = createDb(context.env.DB);
  await db.delete(sessions).where(eq(sessions.id, current.sessionHash));
  await writeAuditEvent(db, {
    action: "session.revoked",
    actorUserId: current.userId,
    entityId: current.sessionHash,
    entityType: "session",
    workspaceId: current.workspaceId
  });
  context.header("Set-Cookie", deleteSessionCookie(context.env));
  return context.body(null, 204);
});

authRoutes.post("/password", requireAuth, async context => {
  const input = await parseJson(context, changePasswordSchema);
  const current = auth(context);
  const db = createDb(context.env.DB);
  const [row] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, current.userId))
    .limit(1);

  if (
    row === undefined ||
    !(await verifyPassword(input.currentPassword, row.passwordHash))
  ) {
    throw new AppError(
      401,
      "invalid_password",
      "The current password is incorrect."
    );
  }

  const now = Date.now();
  await db.batch([
    db
      .update(users)
      .set({
        passwordHash: await hashPassword(input.newPassword),
        updatedAt: now
      })
      .where(eq(users.id, current.userId)),
    db
      .delete(sessions)
      .where(
        and(
          eq(sessions.userId, current.userId),
          ne(sessions.id, current.sessionHash)
        )
      )
  ]);
  await writeAuditEvent(db, {
    action: "password.changed",
    actorUserId: current.userId,
    entityId: current.userId,
    entityType: "user",
    workspaceId: current.workspaceId
  });

  return context.json({ changed: true });
});

authRoutes.get("/sessions", requireAuth, async context => {
  const current = auth(context);
  const rows = await createDb(context.env.DB)
    .select({
      createdAt: sessions.createdAt,
      current: sessions.id,
      expiresAt: sessions.expiresAt,
      id: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      userAgent: sessions.userAgent
    })
    .from(sessions)
    .where(eq(sessions.userId, current.userId));

  return context.json({
    sessions: rows.map(row => ({
      createdAt: row.createdAt,
      current: row.current === current.sessionHash,
      expiresAt: row.expiresAt,
      id: row.id.slice(0, 12),
      lastSeenAt: row.lastSeenAt,
      userAgent: row.userAgent
    }))
  });
});

authRoutes.delete("/sessions/:id", requireAuth, async context => {
  const current = auth(context);
  const prefix = context.req.param("id");
  if (!/^[A-Za-z0-9_-]{12}$/.test(prefix)) {
    throw new AppError(404, "session_not_found", "The session was not found.");
  }
  const db = createDb(context.env.DB);
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(eq(sessions.userId, current.userId), like(sessions.id, prefix + "%"))
    )
    .limit(2);
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new AppError(404, "session_not_found", "The session was not found.");
  }

  await db.delete(sessions).where(eq(sessions.id, rows[0].id));
  await writeAuditEvent(db, {
    action: "session.revoked",
    actorUserId: current.userId,
    entityId: rows[0].id,
    entityType: "session",
    workspaceId: current.workspaceId
  });
  if (rows[0].id === current.sessionHash) {
    context.header("Set-Cookie", deleteSessionCookie(context.env));
  }
  return context.body(null, 204);
});
