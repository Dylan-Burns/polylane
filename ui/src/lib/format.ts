/** Small, dependency-free formatting helpers shared across panels — no date/number library. */

export function relativeTime(ms: number, nowMs: number = Date.now()): string {
  const diffMs = nowMs - ms;
  const future = diffMs < 0;
  const s = Math.round(Math.abs(diffMs) / 1000);
  const suffix = future ? "from now" : "ago";
  if (s < 5) return future ? "in a moment" : "just now";
  if (s < 60) return `${s}s ${suffix}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ${suffix}`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ${suffix}`;
  const d = Math.round(h / 24);
  return `${d}d ${suffix}`;
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** `mm:ss` offset since `startMs` — used for investigation-step timestamps, where "how long into
 * the investigation" matters more than the wall-clock time. */
export function elapsedSince(ms: number, startMs: number): string {
  const totalSeconds = Math.max(0, Math.round((ms - startMs) / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `+${m}:${String(s).padStart(2, "0")}`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const remS = Math.round(s % 60);
  return `${m}m ${remS}s`;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function prettyJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
