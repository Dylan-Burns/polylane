/**
 * Resolves the `{from?, to?}` window shape every read tool accepts (spec §9's tool table)
 * into concrete half-open `[fromMs, toMs)` epoch-millisecond bounds — the same convention
 * `read.ts`'s query functions use. No `Date.now()` in here: callers always pass an explicit
 * `nowMs` (the investigation's/request's anchor time), matching `read.ts`'s own "no wall-clock
 * reads" discipline (Global Constraints: system-prompt timestamps are set once per investigation).
 *
 * Accepts, per bound, either an ISO-8601 timestamp (anything `Date.parse` resolves) or a
 * relative offset from `nowMs` in the form `-<N><unit>` where unit is one of `s`/`m`/`h`/`d`
 * (e.g. `"-30m"`, `"-2h"`, `"-90s"`, `"-1d"`) — always "N units before now", never a positive
 * or future offset. `from` defaults to `"-30m"`, `to` defaults to `nowMs` itself.
 */

/** Thrown when a window bound is neither a valid ISO-8601 timestamp nor a recognized relative
 * offset, or when the resolved window is degenerate (see `parseWindow`). Named so callers
 * (`tools.ts`'s `executeTool`) can catch it specifically and turn it into a `{error}` tool
 * result instead of an uncaught throw. */
export class WindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowError";
  }
}

/** The raw `{from?, to?}` shape a tool call carries — each bound is an ISO-8601 string, a
 * relative offset string, `null` (explicit "use the default", the shape strict tool-use JSON
 * schemas round-trip for an omitted optional field), or `undefined` (plain omission). */
export interface WindowInput {
  from?: string | null;
  to?: string | null;
}

/** The resolved, half-open window bounds every `read.ts` query function takes. */
export interface ResolvedWindow {
  fromMs: number;
  toMs: number;
}

const RELATIVE_PATTERN = /^-(\d+)(s|m|h|d)$/;

const UNIT_MS: Record<"s" | "m" | "h" | "d", number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DEFAULT_LOOKBACK_MS = 30 * UNIT_MS.m; // "-30m"

function resolveTimeString(raw: string, nowMs: number, field: "from" | "to"): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new WindowError(`window.${field} must not be an empty string`);
  }

  const relative = RELATIVE_PATTERN.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2] as "s" | "m" | "h" | "d";
    return nowMs - amount * UNIT_MS[unit];
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new WindowError(
      `window.${field} (${JSON.stringify(raw)}) is neither an ISO-8601 timestamp nor a relative offset like "-30m"`,
    );
  }
  return parsed;
}

/**
 * Resolves a tool call's `{from?, to?}` window input into `[fromMs, toMs)` bounds.
 *
 * Defaults: `from` -> `nowMs - 30m`, `to` -> `nowMs` (missing or explicit `null` both mean
 * "use the default" — see `WindowInput`). Throws `WindowError` when a supplied bound parses as
 * neither ISO-8601 nor a relative offset.
 *
 * `fromMs`/`toMs` are swapped, not rejected, when they resolve in reverse order (e.g. a caller
 * accidentally supplies `from` after `to`) — order decides which bound is "from", not the
 * caller's label, so a reversed-but-otherwise-valid window still resolves usefully instead of
 * failing an investigation step over a labeling slip. The one case swapping can't fix — both
 * bounds resolving to the exact same instant, which would make the half-open `[fromMs, toMs)`
 * window read zero rows — is rejected with `WindowError` instead.
 */
export function parseWindow(input: WindowInput, nowMs: number): ResolvedWindow {
  let fromMs = input.from != null ? resolveTimeString(input.from, nowMs, "from") : nowMs - DEFAULT_LOOKBACK_MS;
  let toMs = input.to != null ? resolveTimeString(input.to, nowMs, "to") : nowMs;

  if (fromMs > toMs) {
    [fromMs, toMs] = [toMs, fromMs];
  }
  if (fromMs === toMs) {
    throw new WindowError(`window is empty: "from" and "to" both resolve to the same instant (${fromMs})`);
  }

  return { fromMs, toMs };
}
