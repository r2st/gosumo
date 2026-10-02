import { securityHeaders } from "./src/lib/security-headers.mjs";

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Type-check is run separately; skip during build to reduce memory on deploy server.
    ignoreBuildErrors: true,
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
      { protocol: "http", hostname: "localhost" },
    ],
  },
  // Applied to every route, including static assets and 404s. `headers()` is
  // resolved at build time into the routes manifest, which is why the env vars
  // below are read here rather than at request time — they are the same
  // NEXT_PUBLIC_* values the client bundle is compiled against, so the CSP can
  // never disagree with the origin the app actually calls.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders({
          apiUrl: process.env.NEXT_PUBLIC_API_URL,
          wsUrl: process.env.NEXT_PUBLIC_WS_URL,
          nodeEnv: process.env.NODE_ENV,
        }),
      },
    ];
  },
};

export default nextConfig;
