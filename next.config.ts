import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The domain core talks to Postgres and SQLite directly; keep those out of the bundle.
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
};

export default nextConfig;
