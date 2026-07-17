/**
 * The incident detail modal's Properties tab (Table 8): the raw record fields — id, lifecycle
 * status/severity, fingerprint chips, timestamps, total token spend (summed from `steps`, which
 * the detail response already carries — no new fetch), and any deploy version strings the report
 * names. Presentation-only, no polling of its own.
 */

import type { ReactNode } from "react";
import { clockTime, formatTokens, relativeTime } from "../../lib/format";
import { INCIDENT_STATUS_META } from "../../lib/status";
import type { IncidentView, StepView } from "../../lib/types";

/** Version strings the report's own text names (vN.N.N — the only version format deploys carry).
 * Extracted from the serialized report exactly like the Deploys rail's correlation chips: the
 * claim is "the report mentions this version", honestly no stronger. */
function versionsNamedInReport(report: unknown): string[] {
  if (report === null || report === undefined) return [];
  let json: string;
  try {
    json = JSON.stringify(report);
  } catch {
    return [];
  }
  return [...new Set(json.match(/\bv\d+\.\d+\.\d+\b/g) ?? [])];
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">{label}</span>
      <div className="text-sm text-ink">{children}</div>
    </div>
  );
}

function TimestampField({ label, ms }: { label: string; ms: number | null }) {
  return (
    <Field label={label}>
      {ms === null ? (
        <span className="text-ink-faint">—</span>
      ) : (
        <span className="font-mono text-xs">
          {clockTime(ms)} <span className="text-ink-faint">({relativeTime(ms)})</span>
        </span>
      )}
    </Field>
  );
}

export function PropertiesTab({ incident, steps }: { incident: IncidentView; steps: StepView[] }) {
  const statusMeta = INCIDENT_STATUS_META[incident.status];
  const tokensIn = steps.reduce((sum, s) => sum + s.tokens_in, 0);
  const tokensOut = steps.reduce((sum, s) => sum + s.tokens_out, 0);
  const versions = versionsNamedInReport(incident.report);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Incident ID">
          <span className="break-all font-mono text-xs">{incident.id}</span>
        </Field>
        <Field label="Status">
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-panel-raised px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide"
            style={{ color: statusMeta.color }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: statusMeta.color }} aria-hidden="true" />
            {statusMeta.label}
          </span>
        </Field>
        <Field label="Severity">
          <span className="font-mono text-xs uppercase tracking-wide text-ink-dim">{incident.severity}</span>
        </Field>
        <Field label="Token spend">
          <span className="font-mono text-xs">
            {formatTokens(tokensIn)} in · {formatTokens(tokensOut)} out
          </span>
        </Field>
      </div>

      <Field label="Fingerprints">
        {incident.fingerprints.length === 0 ? (
          <span className="text-ink-faint">—</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {incident.fingerprints.map((fp) => (
              <span key={fp} className="rounded-full border border-hairline bg-panel-raised px-2 py-0.5 font-mono text-[11px] text-ink-dim">
                {fp}
              </span>
            ))}
          </div>
        )}
      </Field>

      {versions.length > 0 && (
        <Field label="Versions named in report">
          <div className="flex flex-wrap gap-1.5">
            {versions.map((v) => (
              <span key={v} className="rounded-full border border-hairline bg-panel-raised px-2 py-0.5 font-mono text-[11px] text-ink-dim">
                {v}
              </span>
            ))}
          </div>
        </Field>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <TimestampField label="Opened" ms={incident.opened_at} />
        <TimestampField label="Reported" ms={incident.reported_at} />
        <TimestampField label="Resolved" ms={incident.resolved_at} />
      </div>
    </div>
  );
}
