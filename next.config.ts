import type { NextConfig } from "next";

// The Circles host loads miniapps inside an iframe. Default Next.js responses
// would block that with `X-Frame-Options: SAMEORIGIN`, so we explicitly allow
// the Circles host (prod + dev + any future subdomain) and Vercel preview deploys.
const FRAME_ANCESTORS = [
  "'self'",
  "https://*.gnosis.io",
  "https://*.vercel.app",
].join(" ");

const nextConfig: NextConfig = {
  // cosmos.gl's destroy() corrupts shared WebGL state, so the Strict Mode
  // mount→unmount→remount cycle leaves the surviving graph instance unable to render.
  reactStrictMode: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors ${FRAME_ANCESTORS};`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
