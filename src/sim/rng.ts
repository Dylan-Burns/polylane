/**
 * Seeded, deterministic pseudo-random primitives for the telemetry generator (spec §6). Pure:
 * no `Date.now()`, no I/O, no `crypto.randomUUID()` — the same seed always yields the same
 * sequence, which is what makes `generateWindow` reproducible.
 */

/** A seeded PRNG: repeated calls advance internal state and return floats in [0, 1). */
export type Rng = () => number;

/**
 * mulberry32: a small, fast, well-known 32-bit deterministic PRNG. Not cryptographically
 * secure — fine here, determinism is the requirement, not unpredictability.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal sample (Box-Muller transform), driven entirely by `rng`. */
function standardNormal(rng: Rng): number {
  // Exclude 0 from the first draw to avoid Math.log(0) = -Infinity.
  let u1 = rng();
  while (u1 <= Number.EPSILON) u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Log-normal sample: exp(mu + sigma * Z) where Z ~ N(0, 1). `mu`/`sigma` are the parameters of
 * the underlying normal distribution (log-space), so the sample's median is exp(mu).
 */
export function logNormal(rng: Rng, mu: number, sigma: number): number {
  return Math.exp(mu + sigma * standardNormal(rng));
}

/**
 * Poisson-distributed integer sample with mean `lambda` (Knuth's algorithm), driven entirely by
 * `rng`. Used for the "Poisson-ish" traffic jitter called for in spec §6.
 */
export function poisson(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

/**
 * Deterministic lowercase hex string of `byteLen` bytes, drawn from `rng`. Used for trace/span
 * ids in place of `crypto.randomUUID()`, which would break reproducibility for a given seed.
 */
export function randomHex(rng: Rng, byteLen: number): string {
  let out = "";
  for (let i = 0; i < byteLen; i++) {
    const byte = Math.floor(rng() * 256) & 0xff;
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
