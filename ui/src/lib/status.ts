/** Shared color/label vocabulary for the two independent status systems in this app: per-service
 * *health* (red/amber/green, spec §10) and per-incident *lifecycle* status (open → investigating →
 * reported → resolved | failed, spec §8). Kept in one place so a color is never picked twice. */

import type { HealthStatus, IncidentView } from "./types";

export const HEALTH_COLOR: Record<HealthStatus, string> = {
  red: "var(--color-status-red)",
  amber: "var(--color-status-amber)",
  green: "var(--color-status-green)",
};

export const HEALTH_LABEL: Record<HealthStatus, string> = {
  red: "Incident",
  amber: "Degraded",
  green: "Healthy",
};

export type IncidentStatus = IncidentView["status"];

export const INCIDENT_STATUS_META: Record<IncidentStatus, { label: string; color: string; pulse?: boolean }> = {
  open: { label: "Open", color: "var(--color-status-red)", pulse: true },
  investigating: { label: "Investigating", color: "var(--color-signal)", pulse: true },
  reported: { label: "Reported", color: "var(--color-status-amber)" },
  resolved: { label: "Resolved", color: "var(--color-status-green)" },
  failed: { label: "Failed", color: "var(--color-status-gray)" },
};

export const CONFIDENCE_META: Record<"low" | "medium" | "high", { label: string; color: string }> = {
  high: { label: "High confidence", color: "var(--color-status-green)" },
  medium: { label: "Medium confidence", color: "var(--color-status-amber)" },
  low: { label: "Low confidence", color: "var(--color-status-red)" },
};
