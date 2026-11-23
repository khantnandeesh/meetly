import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Live (beta): no Referer leaves the webinar pages, as a header and not only the page's <meta>
  // (src/app/live/[id]/page.tsx), so the id and title stay put whatever the markup's order. The
  // key, in the fragment, never goes in a Referer anyway.
  async headers() {
    return [
      { source: "/live", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/live/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
