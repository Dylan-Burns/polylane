/**
 * The incident detail modal's Logs tab (Table 8): the report's own cited log excerpts (survive
 * indefinitely — baked into `report_json` at submit time, same reasoning as `TraceDrawer.tsx`'s
 * `embedded` preference) above a lazy fetch of the raw window via `getIncidentLogs`, which degrades
 * honestly once retention has purged it rather than rendering a blank tab.
 */

import { useEffect, useState } from "react";
import { getIncidentLogs } from "../../lib/api";
import { clockTime } from "../../lib/format";
import type { LogLine, ReportEvidenceEntry } from "../../lib/types";

const LOG_LEVEL_COLOR: Record<LogLine["level"], string> = {
  info: "text-ink-faint",
  warn: "text-status-amber",
  error: "text-status-red",
};

function ExcerptCard({ entry }: { entry: ReportEvidenceEntry }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-hairline bg-panel px-3 py-2 text-xs">
      <p className="text-ink-dim">{entry.description}</p>
      <p className="font-mono text-[11px] italic text-ink-faint">&ldquo;{entry.log_excerpt}&rdquo;</p>
    </div>
  );
}

function LogRow({ log }: { log: LogLine }) {
  return (
    <p className="font-mono text-[11px] leading-relaxed text-ink-dim">
      <span className="text-ink-faint">{clockTime(log.ts_ms)}</span> <span className={LOG_LEVEL_COLOR[log.level]}>[{log.level}]</span>{" "}
      <span className="text-ink">{log.service}</span>: {log.message}
    </p>
  );
}

type FetchState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; logs: LogLine[]; total: number; truncated: boolean };

export function LogsTab({ incidentId, evidence }: { incidentId: string; evidence: ReportEvidenceEntry[] }) {
  const [state, setState] = useState<FetchState>({ kind: "loading" });

  // Mounts only once this tab is selected (`Detail.tsx` renders tab contents on demand) — that IS
  // the "lazy fetch when the tab first opens" the plan calls for, no extra gating needed here.
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    getIncidentLogs(incidentId)
      .then((res) => {
        if (!cancelled) setState({ kind: "ok", logs: res.logs, total: res.total, truncated: res.truncated });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [incidentId]);

  const excerpts = evidence.filter((e) => e.log_excerpt !== null && e.log_excerpt !== undefined);

  return (
    <div className="flex flex-col gap-5">
      <section>
        <h4 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Evidence log excerpts</h4>
        {excerpts.length === 0 ? (
          <p className="mt-2 text-xs text-ink-dim">No log excerpts were cited in the report.</p>
        ) : (
          <div className="mt-2 flex flex-col gap-1.5">
            {excerpts.map((entry, i) => (
              <ExcerptCard key={i} entry={entry} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h4 className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Raw logs in the incident window</h4>
        {state.kind === "loading" && <p className="mt-2 text-xs text-ink-dim">Loading raw logs…</p>}
        {state.kind === "error" && <p className="mt-2 text-xs text-status-red">Couldn't load raw logs ({state.message}).</p>}
        {state.kind === "ok" && state.logs.length === 0 && (
          <p className="mt-2 text-xs text-ink-dim">
            Raw telemetry has expired for this window — the evidence excerpts above are all that's preserved.
          </p>
        )}
        {state.kind === "ok" && state.logs.length > 0 && (
          <>
            <div className="mt-2 flex flex-col gap-1 rounded-lg border border-hairline bg-panel-raised p-2">
              {state.logs.map((log, i) => (
                <LogRow key={i} log={log} />
              ))}
            </div>
            {state.truncated && (
              <p className="mt-1.5 text-[11px] text-ink-faint">
                Showing {state.logs.length} of {state.total} matching lines.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
