-- Watchtower D1 schema (spec §7).
--
-- Write-budget note (Global Constraints / spec §6): exactly two indexes on
-- `spans`, one on `logs`, one on `rollups` — no primary/unique key is
-- declared on those four tables beyond the implicit SQLite rowid, since a
-- declared PRIMARY KEY on a non-INTEGER column creates an additional b-tree
-- (a third billable index) and would break the ×3 / ×2 / ×2 amplification
-- budget spelled out in spec §6. The other five tables (deploys, incidents,
-- incident_fingerprints, investigation_steps, baselines, meta) are low
-- volume / not part of that budget, so natural keys are used where they
-- make upsert/dedupe semantics (e.g. `REPLACE INTO baselines`) correct.

CREATE TABLE spans (
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  service TEXT NOT NULL,
  operation TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  error_type TEXT
);

CREATE TABLE logs (
  ts_ms INTEGER NOT NULL,
  service TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  trace_id TEXT,
  span_id TEXT
);

CREATE TABLE rollups (
  service TEXT NOT NULL,
  operation TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  p50_ms REAL NOT NULL,
  p95_ms REAL NOT NULL,
  p99_ms REAL NOT NULL
);

CREATE TABLE deploys (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  version TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  note TEXT NOT NULL
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('open', 'investigating', 'reported', 'resolved', 'failed')),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  opened_at INTEGER NOT NULL,
  reported_at INTEGER,
  resolved_at INTEGER,
  trigger_json TEXT NOT NULL,
  report_json TEXT,
  follow_up_of TEXT REFERENCES incidents (id)
);

CREATE TABLE incident_fingerprints (
  incident_id TEXT NOT NULL REFERENCES incidents (id),
  fingerprint TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  delivered_to_agent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (incident_id, fingerprint)
);

CREATE TABLE investigation_steps (
  incident_id TEXT NOT NULL REFERENCES incidents (id),
  step_no INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tool_call', 'tool_result', 'note', 'report', 'error')),
  content_json TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  PRIMARY KEY (incident_id, step_no)
);

CREATE TABLE baselines (
  service TEXT NOT NULL,
  operation TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('req_rate', 'error_rate', 'p95')),
  median REAL NOT NULL,
  mad REAL NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (service, operation, metric)
);

-- Retention watermarks, guardrail counters, world generation. Fault state
-- lives in SimulatorDO storage only — never here (spec §7).
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The four indexes (spec §7): exactly two on spans, one on logs, one on rollups.
-- (The PKs on the six low-volume tables below each add a SQLite autoindex; those
-- tables write ~tens of rows/hour, so the 2x billing there is negligible by design.)
CREATE INDEX idx_spans_service_start_ms ON spans (service, start_ms);
CREATE INDEX idx_spans_trace_id ON spans (trace_id);
CREATE INDEX idx_logs_service_ts_ms ON logs (service, ts_ms);
CREATE INDEX idx_rollups_service_operation_minute_ts ON rollups (service, operation, minute_ts);
