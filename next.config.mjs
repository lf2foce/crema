// One id per build, baked into both the browser bundle and the server: a page that's been open
// across a deploy asks the server for its id and offers a reload when they differ (components/NewVersion.tsx).
const BUILD = String(Date.now());

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Runtime config is JavaScript so the production image needs no TypeScript compiler.
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  generateBuildId: async () => BUILD,
  env: { NEXT_PUBLIC_CREMA_BUILD: BUILD },
};
export default nextConfig;
