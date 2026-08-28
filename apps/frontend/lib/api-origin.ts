export const resolveApiUrl = (
  configuredUrl: string | undefined,
  environment: string | undefined,
  allowInsecureLoopback = false
): string => {
  const value = configuredUrl?.trim();
  if (value === undefined || value.length === 0) {
    if (environment === "production") {
      throw new Error(
        "NEXT_PUBLIC_API_URL must be an exact HTTPS origin before building or deploying the production frontend."
      );
    }
    return "http://localhost:4000";
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("NEXT_PUBLIC_API_URL must be an absolute HTTP(S) origin.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "NEXT_PUBLIC_API_URL must contain only an absolute HTTP(S) origin."
    );
  }
  if (environment === "production") {
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      value !== url.origin ||
      (url.protocol !== "https:" && !(allowInsecureLoopback && loopback))
    ) {
      throw new Error(
        "NEXT_PUBLIC_API_URL must be the exact canonical HTTPS production origin without a trailing slash."
      );
    }
  }
  return url.origin;
};
