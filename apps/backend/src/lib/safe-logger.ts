const sensitiveKeyPattern =
  /authorization|cookie|password|secret|token|credential|code_verifier|upload_url/i;

const sanitize = (value: unknown, depth = 0): unknown => {
  if (depth > 4) {
    return "[max-depth]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => sanitize(item, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKeyPattern.test(key) ? "[redacted]" : sanitize(item, depth + 1)
      ])
    );
  }

  if (typeof value === "string" && value.length > 500) {
    return value.slice(0, 500) + "…";
  }

  return value;
};

export const safeLog = (
  level: "info" | "warn" | "error",
  event: string,
  context: Record<string, unknown> = {}
): void => {
  const payload = JSON.stringify({
    context: sanitize(context),
    event,
    level,
    timestamp: new Date().toISOString()
  });

  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.info(payload);
  }
};
