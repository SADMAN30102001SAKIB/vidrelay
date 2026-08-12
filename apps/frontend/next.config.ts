import type { NextConfig } from "next";

if (
  process.env.NODE_ENV === "production" &&
  !process.env.NEXT_PUBLIC_API_URL?.trim()
) {
  throw new Error(
    "NEXT_PUBLIC_API_URL must be set before building or deploying the production frontend."
  );
}

const nextConfig: NextConfig = {
  images: {
    unoptimized: true
  },
  output: "export",
  reactStrictMode: true,
  trailingSlash: true
};

export default nextConfig;
