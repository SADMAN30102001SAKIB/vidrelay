import type { NextConfig } from "next";

import { resolveApiUrl } from "./lib/api-origin";

const allowInsecureLoopback = process.env.npm_lifecycle_event === "preview";

resolveApiUrl(
  process.env.NEXT_PUBLIC_API_URL,
  process.env.NODE_ENV,
  allowInsecureLoopback
);

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_VIDRELAY_ALLOW_INSECURE_LOOPBACK: allowInsecureLoopback
      ? "true"
      : "false"
  },
  images: {
    unoptimized: true
  },
  output: "export",
  reactStrictMode: true,
  trailingSlash: true
};

export default nextConfig;
