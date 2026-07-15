import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// `@cloudflare/vitest-pool-workers` 0.18.x replaced `defineWorkersConfig` /
// `defineWorkersProject` (from the `/config` subpath) with a Vite plugin,
// `cloudflareTest`, used with `defineConfig` from `vitest/config`. The old
// subpath import no longer exists in this version. `readD1Migrations` moved
// alongside it (still Node-side, reads migration SQL files from disk) —
// there's no more `/config` subpath to import it from either.
export default defineConfig(async () => {
  // Read the real migration files from `migrations/` (not a copy-pasted
  // schema string) so tests exercise exactly what `wrangler d1 migrations
  // apply` would run against the real database. Relative to `process.cwd()`
  // (repo root, where `vitest run` is invoked from) — deliberately avoids
  // `node:path`/`import.meta.dirname` since this project has no `@types/node`
  // (only `@cloudflare/workers-types`, to keep the global scope Workers-only).
  const migrations = await readD1Migrations("migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Test-only binding carrying the migrations array into the worker
          // isolate, where `test/apply-migrations.ts` applies them via
          // `applyD1Migrations` from `cloudflare:test`.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
