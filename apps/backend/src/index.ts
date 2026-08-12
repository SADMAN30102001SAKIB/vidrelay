import { Hono } from "hono";

import type { AppEnv, Bindings } from "./env";
import { AppError } from "./lib/errors";
import { getPublicConfig } from "./lib/capabilities";
import { safeLog } from "./lib/safe-logger";
import { corsAndCsrf, requestContext } from "./middleware/security";
import { dispatchOutbox } from "./publishing/outbox";
import { PublishWorkflow } from "./publishing/workflow";
import {
  accountRoutes,
  deletionStatusRoutes,
  processDeletionRequests
} from "./routes/account";
import { authRoutes } from "./routes/auth";
import { connectionRoutes, oauthRoutes } from "./routes/connections";
import { mediaRoutes, previewRoutes } from "./routes/media";
import { postRoutes } from "./routes/posts";
import { cleanupUploads, uploadRoutes } from "./routes/uploads";
import { webhookRoutes } from "./routes/webhooks";

const app = new Hono<AppEnv>();

app.use("*", requestContext);
app.use("*", corsAndCsrf);

app.get("/health", context =>
  context.json({
    environment: context.env.APP_ENV,
    service: "vidrelay-api",
    status: "ok"
  })
);
app.get("/api/config", context => context.json(getPublicConfig(context.env)));
app.route("/api/auth", authRoutes);
app.route("/api/oauth", oauthRoutes);
app.route("/api/connections", connectionRoutes);
app.route("/api/uploads", uploadRoutes);
app.route("/api/uploads", previewRoutes);
app.route("/api/posts", postRoutes);
app.route("/api/account", accountRoutes);
app.route("/api/deletion-status", deletionStatusRoutes);
app.route("/api/webhooks", webhookRoutes);
app.route("/media", mediaRoutes);

app.notFound(context =>
  context.json(
    {
      error: {
        code: "not_found",
        message: "The requested resource was not found."
      },
      requestId: context.get("requestId")
    },
    404
  )
);

app.onError((error, context) => {
  if (error instanceof AppError) {
    const payload: {
      error: {
        code: string;
        details?: Record<string, unknown>;
        message: string;
      };
      requestId: string;
    } = {
      error: {
        code: error.code,
        message: error.message
      },
      requestId: context.get("requestId")
    };
    if (error.details !== undefined) {
      payload.error.details = error.details;
    }
    return context.json(payload, error.status);
  }

  safeLog("error", "request.unhandled_error", {
    error: error instanceof Error ? error.message : "unknown",
    method: context.req.method,
    path: context.req.path,
    requestId: context.get("requestId")
  });
  return context.json(
    {
      error: {
        code: "internal_error",
        message: "The request could not be completed."
      },
      requestId: context.get("requestId")
    },
    500
  );
});

const cleanExpiredRecords = async (bindings: Bindings): Promise<void> => {
  const now = Date.now();
  const authAttemptCutoff = now - 24 * 60 * 60 * 1000;
  const consumedOauthCutoff = now - 60 * 60 * 1000;
  await bindings.DB.batch([
    bindings.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    bindings.DB.prepare(
      "DELETE FROM oauth_states WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)"
    ).bind(now, consumedOauthCutoff),
    bindings.DB.prepare(
      "DELETE FROM media_leases WHERE expires_at < ? OR revoked_at IS NOT NULL"
    ).bind(now),
    bindings.DB.prepare("DELETE FROM auth_attempts WHERE updated_at < ?").bind(
      authAttemptCutoff
    )
  ]);
};

const runMaintenance = async (bindings: Bindings): Promise<void> => {
  const tasks = [
    { name: "outbox", run: () => dispatchOutbox(bindings) },
    { name: "deletions", run: () => processDeletionRequests(bindings) },
    { name: "upload_cleanup", run: () => cleanupUploads(bindings) },
    { name: "expiry_cleanup", run: () => cleanExpiredRecords(bindings) }
  ];
  const results = await Promise.allSettled(tasks.map(task => task.run()));
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      safeLog("error", "maintenance.task_failed", {
        error: result.reason instanceof Error ? result.reason.message : "unknown",
        task: tasks[index]?.name ?? "unknown"
      });
    }
  }
};

export { PublishWorkflow };

export default {
  fetch: (request, bindings, executionContext) =>
    app.fetch(request, bindings, executionContext),
  scheduled: (_controller, bindings, executionContext) => {
    executionContext.waitUntil(runMaintenance(bindings));
  }
} satisfies ExportedHandler<Bindings>;
