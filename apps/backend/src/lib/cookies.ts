import type { Bindings } from "../env";

export const sessionCookieName = "vidrelay_session";

export const readCookie = (request: Request, name: string): string | null => {
  const header = request.headers.get("Cookie");
  if (header === null) {
    return null;
  }

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = pair.slice(0, separator).trim();
    if (key === name) {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    }
  }

  return null;
};

export const createSessionCookie = (
  token: string,
  bindings: Bindings,
  maxAgeSeconds: number
): string => {
  const production = bindings.APP_ENV === "production";
  const attributes = [
    sessionCookieName + "=" + encodeURIComponent(token),
    "Path=/",
    "HttpOnly",
    "Max-Age=" + String(maxAgeSeconds),
    production ? "SameSite=None" : "SameSite=Lax"
  ];

  if (production) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
};

export const deleteSessionCookie = (bindings: Bindings): string =>
  createSessionCookie("", bindings, 0);
