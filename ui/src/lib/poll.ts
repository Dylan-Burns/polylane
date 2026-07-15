/**
 * A minimal polling hook — no react-query, per the task brief. `usePoll` fetches immediately on
 * mount/dependency change, then re-fetches every `intervalMs` on a `setTimeout` chain (not
 * `setInterval`): each cycle only schedules its next tick after the current fetch settles, so a
 * slow response can never pile up overlapping in-flight requests. Passing `intervalMs: null` pauses
 * polling entirely after the initial fetch — used for the incident-detail poll, which runs at 2s
 * while `status === "investigating"` and stops once the incident reaches a terminal-for-the-UI
 * state (see `panels/incidents/Detail.tsx`).
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface PollState<T> {
  data: T | undefined;
  error: unknown;
  /** True only for the very first in-flight fetch — later cycles keep showing stale `data` while
   * refetching rather than flashing a loading state on every tick. */
  loading: boolean;
}

export interface PollHandle<T> extends PollState<T> {
  /** Forces an immediate re-fetch outside the normal cadence (e.g. right after a chaos action, so
   * the topology/health don't wait up to 5s to reflect it) and resets the interval timer. */
  refresh: () => void;
}

export function usePoll<T>(fetchFn: () => Promise<T>, intervalMs: number | null): PollHandle<T> {
  const [state, setState] = useState<PollState<T>>({ data: undefined, error: undefined, loading: true });
  const fetchRef = useRef(fetchFn);
  fetchRef.current = fetchFn;
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generationRef = useRef(0);

  const runCycle = useCallback(
    (generation: number) => {
      fetchRef
        .current()
        .then((data) => {
          if (generation !== generationRef.current) return;
          setState({ data, error: undefined, loading: false });
        })
        .catch((error: unknown) => {
          if (generation !== generationRef.current) return;
          setState((prev) => ({ data: prev.data, error, loading: false }));
        })
        .finally(() => {
          if (generation !== generationRef.current) return;
          if (intervalMs !== null) {
            timerRef.current = setTimeout(() => runCycle(generation), intervalMs);
          }
        });
    },
    [intervalMs],
  );

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    setState((prev) => ({ ...prev, loading: prev.data === undefined }));
    runCycle(generation);

    return () => {
      generationRef.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // `runCycle` already depends on `intervalMs`; `fetchFn` identity is deliberately not a
    // dependency (see `fetchRef`) so callers can pass an inline closure without re-triggering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, runCycle]);

  const refresh = useCallback(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    runCycle(generation);
  }, [runCycle]);

  return { ...state, refresh };
}
