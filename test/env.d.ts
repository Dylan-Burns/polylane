// Test-only ambient augmentation of `Cloudflare.Env` (the type of `env` from
// `cloudflare:workers`), so `test/apply-migrations.ts` can access
// `env.DB` and the `TEST_MIGRATIONS` binding injected via
// `vitest.config.ts`'s `miniflare.bindings`. Production code uses the
// explicit `Env` type from `src/env.d.ts` instead (via Hono's `Bindings`
// generic), so this doesn't touch runtime code.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
