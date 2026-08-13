import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../env";
import { AppError } from "../lib/errors";

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const allowedOrigins = (value: string): Set<string> =>
  new Set(
    value
      .split(",")
      .map(origin => origin.trim())
      .filter(origin => origin.length > 0)
  );

export const requestContext: MiddlewareHandler<AppEnv> = async (
  context,
  next
) => {
  const requestId = context.req.header("CF-Ray") ?? crypto.randomUUID();
  context.set("requestId", requestId);

  try {
    await next();
  } finally {
    context.header("X-Request-Id", requestId);
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Referrer-Policy", "strict-origin-when-cross-origin");
    context.header(
      "Permissions-Policy",
      "camera=(), geolocation=(), microphone=()"
    );
    context.header("X-Frame-Options", "DENY");
    context.header("Cache-Control", "no-store");
  }
};

export const corsAndCsrf: MiddlewareHandler<AppEnv> = async (context, next) => {
  const origin = context.req.header("Origin");
  const allowed = allowedOrigins(context.env.APP_ORIGINS);
  const isAllowed = origin !== undefined && allowed.has(origin);

  if (origin !== undefined && !isAllowed) {
    throw new AppError(
      403,
      "origin_not_allowed",
      "This request origin is not allowed."
    );
  }

  if (isAllowed) {
    context.header("Access-Control-Allow-Origin", origin);
    context.header("Access-Control-Allow-Credentials", "true");
    context.header("Vary", "Origin", { append: true });
  }

  if (context.req.method === "OPTIONS") {
    if (!isAllowed) {
      throw new AppError(
        403,
        "origin_not_allowed",
        "This request origin is not allowed."
      );
    }
    context.header(
      "Access-Control-Allow-Headers",
      "Content-Type, X-VidRelay-CSRF"
    );
    context.header(
      "Access-Control-Allow-Methods",
      "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
    );
    context.header("Access-Control-Max-Age", "600");
    return context.body(null, 204);
  }

  const protectedBrowserMutation =
    unsafeMethods.has(context.req.method) &&
    context.req.path.startsWith("/api/") &&
    !context.req.path.startsWith("/api/webhooks/");

  if (protectedBrowserMutation) {
    if (!isAllowed || context.req.header("X-VidRelay-CSRF") !== "1") {
      throw new AppError(
        403,
        "csrf_check_failed",
        "The request failed the origin or CSRF check."
      );
    }
  }

  return await next();
};
