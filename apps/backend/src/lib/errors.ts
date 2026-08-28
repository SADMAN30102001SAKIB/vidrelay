import type { ContentfulStatusCode } from "hono/utils/http-status";

export class AppError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  readonly status: ContentfulStatusCode;

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ProviderError extends Error {
  readonly code: string;
  readonly outcomeUnknown: boolean;
  readonly providerCode: string | null;
  readonly providerStatus: number | null;
  readonly providerSubcode: string | null;
  readonly retryAfterSeconds: number | null;
  readonly retryable: boolean;

  constructor(options: {
    code: string;
    message: string;
    outcomeUnknown?: boolean | undefined;
    providerCode?: string | undefined;
    providerStatus?: number | undefined;
    providerSubcode?: string | undefined;
    retryAfterSeconds?: number | undefined;
    retryable?: boolean | undefined;
  }) {
    super(options.message);
    this.name = "ProviderError";
    this.code = options.code;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.providerCode = options.providerCode ?? null;
    this.providerStatus = options.providerStatus ?? null;
    this.providerSubcode = options.providerSubcode ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.retryable = options.retryable ?? false;
  }
}
