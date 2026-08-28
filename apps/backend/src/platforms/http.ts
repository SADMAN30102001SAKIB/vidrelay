import { ProviderError } from "../lib/errors";

const providerErrorDetails = (
  body: unknown
): { code: string; message: string; subcode: string | null } => {
  if (body !== null && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "string") {
      return {
        code: error.slice(0, 100),
        message: error.slice(0, 300),
        subcode: null
      };
    }
    if (error !== null && typeof error === "object") {
      const value = error as Record<string, unknown>;
      return {
        code:
          typeof value.code === "string" || typeof value.code === "number"
            ? String(value.code).slice(0, 100)
            : "provider_error",
        message:
          typeof value.message === "string"
            ? value.message.slice(0, 300)
            : "The provider rejected the request.",
        subcode:
          typeof value.error_subcode === "string" ||
          typeof value.error_subcode === "number"
            ? String(value.error_subcode).slice(0, 100)
            : null
      };
    }
    if (typeof record.error_description === "string") {
      return {
        code: "provider_error",
        message: record.error_description.slice(0, 300),
        subcode: null
      };
    }
  }

  return {
    code: "provider_error",
    message: "The provider rejected the request.",
    subcode: null
  };
};

export const providerJson = async <T>(
  url: string,
  init: RequestInit,
  options: {
    operation: string;
    outcomeUnknown?: boolean;
  }
): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(2 * 60 * 1000)
    });
  } catch {
    throw new ProviderError({
      code: options.operation + "_network_error",
      message: "The provider request did not return a response.",
      outcomeUnknown: options.outcomeUnknown,
      retryable: true
    });
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ProviderError({
      code: options.operation + "_response_error",
      message: "The provider response could not be read.",
      outcomeUnknown: options.outcomeUnknown,
      providerStatus: response.status,
      retryable: true
    });
  }

  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const details = providerErrorDetails(body);
    const authorizationInvalid =
      response.status === 401 ||
      details.code === "102" ||
      details.code === "190";
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new ProviderError({
      code: authorizationInvalid ? "reauth_required" : details.code,
      message: authorizationInvalid
        ? "Reconnect the provider account before publishing again."
        : details.message,
      outcomeUnknown:
        options.outcomeUnknown === true &&
        (response.status === 408 || response.status >= 500),
      providerCode: details.code,
      providerStatus: response.status,
      providerSubcode: details.subcode ?? undefined,
      retryAfterSeconds:
        Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined,
      retryable:
        !authorizationInvalid &&
        (response.status === 429 || response.status >= 500)
    });
  }

  return body as T;
};

export const formBody = (values: Record<string, string>): string =>
  new URLSearchParams(values).toString();
