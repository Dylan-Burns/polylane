import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// `@cloudflare/vitest-pool-workers` 0.18.x replaced `defineWorkersConfig` /
// `defineWorkersProject` (from the `/config` subpath) with a Vite plugin,
// `cloudflareTest`, used with `defineConfig` from `vitest/config`. The old
// subpath import no longer exists in this version.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
