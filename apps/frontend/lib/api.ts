import { apiErrorSchema } from "@vidrelay/shared";

export const sessionExpiredEvent = "vidrelay:session-expired";

export const resolveApiUrl = (
  configuredUrl: string | undefined,
  environment: string | undefined
): string => {
  const value = configuredUrl?.trim();
  if (value !== undefined && value.length > 0) {
    return value.replace(/\/$/, "");
  }
  if (environment === "production") {
    throw new Error(
      "NEXT_PUBLIC_API_URL must be set before building or deploying the production frontend."
    );
  }
  return "http://localhost:4000";
};

export const API_URL = resolveApiUrl(
  process.env.NEXT_PUBLIC_API_URL,
  process.env.NODE_ENV
);

export const apiUrl = (path: string): string =>
  API_URL + (path.startsWith("/") ? path : `/${path}`);

export class ApiClientError extends Error {
  readonly code: string;
  readonly requestId: string | undefined;
  readonly status: number;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId?: string
  ) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.requestId = requestId;
    this.status = status;
  }
}

export const apiRequest = async <T>(
  path: string,
  init: RequestInit = {}
): Promise<T> => {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("X-VidRelay-CSRF", "1");
  }
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: "include",
    headers,
    method
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event(sessionExpiredEvent));
    }
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      throw new ApiClientError(
        response.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.requestId
      );
    }
    throw new ApiClientError(
      response.status,
      "unexpected_response",
      `The service returned an unexpected ${response.status} response.`
    );
  }
  return body as T;
};

export const errorMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
