/** @type {import('next').NextConfig} */
const nextConfig = {
  // Runtime config is JavaScript so the production image needs no TypeScript compiler.
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
};
export default nextConfig;
