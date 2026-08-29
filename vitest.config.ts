import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Minimal test harness for the upload-media-architecture spec (Phase 8).
// - `vite-tsconfig-paths` wires the `@/*` alias from tsconfig.json so tests can
//   import project modules exactly as the app does.
// - Default environment is `node` for server-only tests (verifyRequest, the
//   confirm route, idempotent insert). Browser-ish tests (preprocessImage /
//   Canvas) can opt in per-file with a top-of-file pragma:
//       // @vitest-environment jsdom
//   Later tasks (13.2+) add the `jsdom` + browser deps when they actually
//   introduce browser-only tests; this config does not force those deps now.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
