import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to THIS project directory. Without this, Next infers
  // the root from the nearest lockfile and was picking up a stray (empty)
  // yarn.lock in the home directory, mis-detecting the root. `import.meta.dirname`
  // is the folder of this config file (the project root), so it stays correct on
  // any machine / CI / Vercel (no hard-coded absolute path).
  turbopack: {
    root: import.meta.dirname,
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.public.blob.vercel-storage.com",
      },
      {
        protocol: "https",
        hostname: "img.magnific.com",
      },
      {
        protocol: "https",
        hostname: "picsum.photos",
      },
    ],
    formats: ["image/avif", "image/webp"],
    deviceSizes: [640, 750, 828, 1080, 1200],
    imageSizes: [256, 384, 512],
  },
  async headers() {
    return [
      // Baseline security headers applied to EVERY route. These are the
      // low-risk hardening headers that do NOT depend on knowing every allowed
      // origin, so they will not break Google Analytics, Vercel Blob images, the
      // service worker, or Tailwind's inline styles.
      //
      // NOTE (P1-3): a Content-Security-Policy is intentionally NOT set here yet.
      // This app loads GA (@next/third-parties), Vercel Blob media, an external
      // styles bundle (azeriand-library) and inline styles, so a CSP must be
      // tuned and validated against the real deployment before enabling it —
      // shipping a wrong CSP silently breaks those. See
      // docs/plan-correcciones-produccion.md (P1-3).
      {
        source: "/:path*",
        headers: [
          // Stop MIME sniffing.
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Disallow being framed (clickjacking). Use SAMEORIGIN so any
          // same-origin embedding still works.
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // Don't leak full URLs to third parties on cross-origin navigations.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Force HTTPS for 2 years incl. subdomains. Only meaningful over HTTPS
          // (ignored on plain HTTP), so it is safe to always send in production.
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          // Drop powerful features the app does not use.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
      // PWA service worker: correct MIME + never cache the SW file itself so
      // clients always pick up a new version (Next 16 PWA guide).
      {
        source: "/sw.js",
        headers: [
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
