import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { Anomaly } from "../../src/detect/rules";
import {
  appendFingerprints,
  autoResolve,
  forceFailStuck,
  markDelivered,
  openIncident,
  setStatus,
  undeliveredUpdates,
} from "../../src/telemetry/incidents";
import type { IncidentView } from "../../src/telemetry/types";

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 14, 0, 0);

function mkAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    fingerprint: "payments:errors",
    service: "payments",
    metricClass: "errors",
    rule: "sustained",
    value: 0.3,
    baseline: 0.01,
    statement: "payments error_rate 30.0% vs baseline 1.0% (sustained) since 14:00Z",
    ...overrides,
  };
}

async function incidentRow(id: string) {
  return env.DB.prepare(
    "SELECT id, status, severity, opened_at, reported_at, resolved_at, trigger_json, report_json FROM incidents WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      status: IncidentView["status"];
      severity: IncidentView["severity"];
      opened_at: number;
      reported_at: number | null;
      resolved_at: number | null;
      trigger_json: string;
      report_json: string | null;
    }>();
}

async function fingerprintRows(incidentId: string) {
  const { results } = await env.DB.prepare(
    "SELECT fingerprint, first_seen_ms, delivered_to_agent FROM incident_fingerprints WHERE incident_id = ? ORDER BY fingerprint",
  )
    .bind(incidentId)
    .all<{ fingerprint: string; first_seen_ms: number; delivered_to_agent: number }>();
  return results ?? [];
}

async function countIncidents(): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) as n FROM incidents").first<{ n: number }>();
  return row?.n ?? 0;
}

afterEach(async () => {
  for (const table of ["incident_fingerprints", "investigation_steps", "incidents", "meta"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
});

describe("openIncident", () => {
  it("creates a new incident with the opening batch's fingerprints and trigger_json", async () => {
    const anomalies = [
      mkAnomaly({ fingerprint: "payments:errors", service: "payments", rule: "hard" }),
      mkAnomaly({
        fingerprint: "payments:latency",
        service: "payments",
        metricClass: "latency",
        rule: "hard",
        statement: "payments p95 900ms vs baseline 100ms (hard trip) since 14:00Z",
      }),
    ];

    const { id, created } = await openIncident(env.DB, anomalies, T0);
    expect(created).toBe(true);

    const row = await incidentRow(id);
    expect(row?.status).toBe("open");
    expect(row?.opened_at).toBe(T0);
    expect(row?.reported_at).toBeNull();
    expect(row?.resolved_at).toBeNull();

    const trigger = JSON.parse(row?.trigger_json ?? "{}") as { statements: string[]; anomalies: Anomaly[] };
    expect(trigger.statements).toHaveLength(2);
    expect(trigger.anomalies).toHaveLength(2);

    const fps = await fingerprintRows(id);
    expect(fps.map((f) => f.fingerprint)).toEqual(["payments:errors", "payments:latency"]);
    expect(fps.every((f) => f.delivered_to_agent === 0)).toBe(true);
    expect(fps.every((f) => f.first_seen_ms === T0)).toBe(true);
  });

  it("throws on an empty anomalies array (caller bug guard)", async () => {
    await expect(openIncident(env.DB, [], T0)).rejects.toThrow(/non-empty/);
  });

  // --- Severity mapping ------------------------------------------------------------------------

  it("severity: single service, sustained-only rule -> warning", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly({ rule: "sustained" })], T0);
    const row = await incidentRow(id);
    expect(row?.severity).toBe("warning");
  });

  it("severity: any hard-trip rule -> critical, even with a single service", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly({ rule: "hard" })], T0);
    const row = await incidentRow(id);
    expect(row?.severity).toBe("critical");
  });

  it("severity: >= 2 distinct services, all sustained -> critical", async () => {
    const anomalies = [
      mkAnomaly({ fingerprint: "payments:errors", service: "payments", rule: "sustained" }),
      mkAnomaly({ fingerprint: "checkout:errors", service: "checkout", rule: "sustained" }),
    ];
    const { id } = await openIncident(env.DB, anomalies, T0);
    const row = await incidentRow(id);
    expect(row?.severity).toBe("critical");
  });

  it("severity is fixed at open and not recomputed by appendFingerprints (warning stays warning even once a 2nd service is appended)", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors", service: "payments", rule: "sustained" })], T0);
    expect((await incidentRow(id))?.severity).toBe("warning");

    await appendFingerprints(
      env.DB,
      id,
      [mkAnomaly({ fingerprint: "checkout:errors", service: "checkout", rule: "hard" })],
      T0 + MIN,
    );
    expect((await incidentRow(id))?.severity).toBe("warning");
  });

  // --- Dedupe suppression per status ------------------------------------------------------------

  it.each(["open", "investigating", "reported"] as const)(
    "an incident in status '%s' suppresses a new incident for a covered fingerprint",
    async (status) => {
      const first = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0);
      await setStatus(env.DB, first.id, status);

      const second = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0 + MIN);
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
      expect(await countIncidents()).toBe(1);
    },
  );

  it("a 'resolved' incident never suppresses, regardless of how recently it resolved", async () => {
    const first = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0);
    await setStatus(env.DB, first.id, "resolved", { ts: { field: "resolved_at", value: T0 + 1_000 } });

    const second = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0 + 2_000);
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(await countIncidents()).toBe(2);
  });

  // --- Re-arm timing for 'failed' -----------------------------------------------------------------

  it("a 'failed' incident still suppresses 9 minutes after its terminal timestamp (within the 10-min re-arm)", async () => {
    const first = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0);
    await setStatus(env.DB, first.id, "failed", { ts: { field: "resolved_at", value: T0 } });

    const second = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0 + 9 * MIN);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it("a 'failed' incident no longer suppresses 11 minutes after its terminal timestamp (past the 10-min re-arm)", async () => {
    const first = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0);
    await setStatus(env.DB, first.id, "failed", { ts: { field: "resolved_at", value: T0 } });

    const second = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0 + 11 * MIN);
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(await countIncidents()).toBe(2);
  });

  it("batch-level dedupe: a new anomaly batch sharing even one fingerprint with a covering incident is folded in wholesale, not split", async () => {
    const first = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors", service: "payments" })], T0);

    const secondBatch = [
      mkAnomaly({ fingerprint: "payments:errors", service: "payments" }), // already covered
      mkAnomaly({ fingerprint: "payments:latency", service: "payments", metricClass: "latency" }), // new
    ];
    const second = await openIncident(env.DB, secondBatch, T0 + MIN);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });
});

describe("appendFingerprints", () => {
  it("INSERT OR IGNORE semantics: an already-tracked fingerprint keeps its original first_seen_ms and delivered flag", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0);
    await markDelivered(env.DB, id, ["payments:errors"]);

    await appendFingerprints(env.DB, id, [mkAnomaly({ fingerprint: "payments:errors" })], T0 + MIN);

    const fps = await fingerprintRows(id);
    expect(fps).toHaveLength(1);
    expect(fps[0]?.first_seen_ms).toBe(T0); // not bumped to T0+MIN
    expect(fps[0]?.delivered_to_agent).toBe(1); // not reset to 0
  });

  it("a genuinely new fingerprint gets its own row with delivered_to_agent = 0 and first_seen_ms = nowMs", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0);

    await appendFingerprints(
      env.DB,
      id,
      [mkAnomaly({ fingerprint: "payments:latency", service: "payments", metricClass: "latency" })],
      T0 + MIN,
    );

    const fps = await fingerprintRows(id);
    const latency = fps.find((f) => f.fingerprint === "payments:latency");
    expect(latency?.first_seen_ms).toBe(T0 + MIN);
    expect(latency?.delivered_to_agent).toBe(0);
  });

  it("appends to trigger_json's statements/anomalies audit trail", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0);
    await appendFingerprints(env.DB, id, [mkAnomaly({ fingerprint: "payments:errors", value: 0.4 })], T0 + MIN);

    const row = await incidentRow(id);
    const trigger = JSON.parse(row?.trigger_json ?? "{}") as { statements: string[]; anomalies: Anomaly[] };
    expect(trigger.anomalies).toHaveLength(2);
    expect(trigger.statements).toHaveLength(2);
  });

  it("is a no-op for an empty anomalies array", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0);
    await appendFingerprints(env.DB, id, [], T0 + MIN);
    expect(await fingerprintRows(id)).toHaveLength(1);
  });

  it("does not double-track a fingerprint that belongs to a DIFFERENT, still-active incident when a batch spans two open incidents", async () => {
    const incidentA = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors", service: "payments" })], T0);
    const incidentB = await openIncident(
      env.DB,
      [mkAnomaly({ fingerprint: "checkout:latency", service: "checkout", metricClass: "latency" })],
      T0 + MIN,
    );

    // A single sweep tick's batch happens to span both unrelated incidents' fingerprints.
    const batch = [
      mkAnomaly({ fingerprint: "payments:errors", service: "payments" }),
      mkAnomaly({ fingerprint: "checkout:latency", service: "checkout", metricClass: "latency" }),
    ];
    const { id: coveringId, created } = await openIncident(env.DB, batch, T0 + 2 * MIN);
    expect(created).toBe(false);

    await appendFingerprints(env.DB, coveringId, batch, T0 + 2 * MIN);

    // payments:errors must stay tracked ONLY on incidentA; checkout:latency ONLY on incidentB --
    // neither incident should have picked up the other's fingerprint.
    const aFps = (await fingerprintRows(incidentA.id)).map((f) => f.fingerprint);
    const bFps = (await fingerprintRows(incidentB.id)).map((f) => f.fingerprint);
    expect(aFps).toEqual(["payments:errors"]);
    expect(bFps).toEqual(["checkout:latency"]);
  });
});

describe("undeliveredUpdates / markDelivered", () => {
  it("returns the fingerprint + latest statement for every undelivered fingerprint, and nothing once delivered", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors", value: 0.3 })], T0);

    let undelivered = await undeliveredUpdates(env.DB, id);
    expect(undelivered).toHaveLength(1);
    expect(undelivered[0]?.fingerprint).toBe("payments:errors");
    expect(undelivered[0]?.statement).toContain("payments");

    await markDelivered(env.DB, id, [undelivered[0]?.fingerprint as string]);
    undelivered = await undeliveredUpdates(env.DB, id);
    expect(undelivered).toEqual([]);
  });

  it("a newly-appended fingerprint shows up as undelivered independently of an already-delivered one", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0);
    await markDelivered(env.DB, id, ["payments:errors"]);

    await appendFingerprints(
      env.DB,
      id,
      [mkAnomaly({ fingerprint: "payments:latency", service: "payments", metricClass: "latency", statement: "latency statement" })],
      T0 + MIN,
    );

    const undelivered = await undeliveredUpdates(env.DB, id);
    expect(undelivered).toEqual([{ fingerprint: "payments:latency", statement: "latency statement" }]);
  });

  it("returns [] for an unknown incident id", async () => {
    expect(await undeliveredUpdates(env.DB, "no-such-incident")).toEqual([]);
  });
});

describe("setStatus", () => {
  it("sets status alone when no ts/reportPatch is given", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly()], T0);
    await setStatus(env.DB, id, "investigating");
    const row = await incidentRow(id);
    expect(row?.status).toBe("investigating");
    expect(row?.reported_at).toBeNull();
  });

  it("stamps the requested ts field", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly()], T0);
    await setStatus(env.DB, id, "reported", { ts: { field: "reported_at", value: T0 + 3 * MIN } });
    const row = await incidentRow(id);
    expect(row?.status).toBe("reported");
    expect(row?.reported_at).toBe(T0 + 3 * MIN);
  });

  it("writes reportPatch as JSON into report_json", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly()], T0);
    await setStatus(env.DB, id, "failed", {
      ts: { field: "resolved_at", value: T0 + MIN },
      reportPatch: { failure_reason: "world reset" },
    });
    const row = await incidentRow(id);
    expect(row?.status).toBe("failed");
    expect(JSON.parse(row?.report_json ?? "{}")).toEqual({ failure_reason: "world reset" });
  });
});

describe("autoResolve", () => {
  it("resolves an 'open' incident once every fingerprint has been healthy for 5 consecutive minutes", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0);

    await autoResolve(env.DB, T0 + 4 * MIN + 59_000); // just under 5 min -> not yet
    expect((await incidentRow(id))?.status).toBe("open");

    await autoResolve(env.DB, T0 + 5 * MIN); // exactly 5 min since last anomalous sighting -> resolves
    const row = await incidentRow(id);
    expect(row?.status).toBe("resolved");
    expect(row?.resolved_at).toBe(T0 + 5 * MIN);
  });

  it("resolves a 'reported' incident the same way", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0);
    await setStatus(env.DB, id, "reported", { ts: { field: "reported_at", value: T0 + MIN } });

    await autoResolve(env.DB, T0 + 5 * MIN);
    expect((await incidentRow(id))?.status).toBe("resolved");
  });

  it("does NOT resolve while at least one fingerprint is still anomalous, even if others are healthy", async () => {
    const { id } = await openIncident(
      env.DB,
      [
        mkAnomaly({ fingerprint: "payments:errors", service: "payments" }),
        mkAnomaly({ fingerprint: "checkout:errors", service: "checkout" }),
      ],
      T0,
    );
    // payments:errors keeps re-firing (still anomalous); checkout:errors never fires again.
    await appendFingerprints(env.DB, id, [mkAnomaly({ fingerprint: "payments:errors", service: "payments" })], T0 + 3 * MIN);

    await autoResolve(env.DB, T0 + 3 * MIN + 4 * MIN); // checkout:errors healthy 7min, payments:errors only 4min
    expect((await incidentRow(id))?.status).toBe("open");

    await autoResolve(env.DB, T0 + 3 * MIN + 5 * MIN); // now 5min since payments:errors too
    expect((await incidentRow(id))?.status).toBe("resolved");
  });

  it("never touches an 'investigating' incident (it always runs to its report)", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0);
    await setStatus(env.DB, id, "investigating");

    await autoResolve(env.DB, T0 + 30 * MIN);
    expect((await incidentRow(id))?.status).toBe("investigating");
  });

  it("does not throw when there are no open/reported incidents", async () => {
    await expect(autoResolve(env.DB, T0)).resolves.toBeUndefined();
  });
});

describe("forceFailStuck", () => {
  it("does not fail an investigating incident with a step at exactly 6 minutes ago", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly()], T0);
    await setStatus(env.DB, id, "investigating");
    await env.DB.prepare(
      "INSERT INTO investigation_steps (incident_id, step_no, kind, content_json, ts_ms, tokens_in, tokens_out) VALUES (?, 1, 'note', '{}', ?, 0, 0)",
    )
      .bind(id, T0)
      .run();

    await forceFailStuck(env.DB, T0 + 6 * MIN); // exactly 6 min -> not yet stuck (strictly >)
    expect((await incidentRow(id))?.status).toBe("investigating");
  });

  it("fails an investigating incident 1ms past the 6-minute mark", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly()], T0);
    await setStatus(env.DB, id, "investigating");
    await env.DB.prepare(
      "INSERT INTO investigation_steps (incident_id, step_no, kind, content_json, ts_ms, tokens_in, tokens_out) VALUES (?, 1, 'note', '{}', ?, 0, 0)",
    )
      .bind(id, T0)
      .run();

    await forceFailStuck(env.DB, T0 + 6 * MIN + 1);
    const row = await incidentRow(id);
    expect(row?.status).toBe("failed");
    expect(row?.resolved_at).toBe(T0 + 6 * MIN + 1);
    expect(JSON.parse(row?.report_json ?? "{}")).toMatchObject({ failure_reason: expect.stringContaining("stuck") });
  });

  it("uses opened_at as the reference point when there are zero investigation_steps rows yet", async () => {
    const { id } = await openIncident(env.DB, [mkAnomaly()], T0);
    await setStatus(env.DB, id, "investigating");

    await forceFailStuck(env.DB, T0 + 6 * MIN);
    expect((await incidentRow(id))?.status).toBe("investigating");

    await forceFailStuck(env.DB, T0 + 6 * MIN + 1);
    expect((await incidentRow(id))?.status).toBe("failed");
  });

  it("does not touch incidents in other statuses", async () => {
    const open = await openIncident(env.DB, [mkAnomaly({ fingerprint: "payments:errors" })], T0);
    const reported = await openIncident(env.DB, [mkAnomaly({ fingerprint: "checkout:errors", service: "checkout" })], T0);
    await setStatus(env.DB, reported.id, "reported", { ts: { field: "reported_at", value: T0 } });

    await forceFailStuck(env.DB, T0 + 60 * MIN);
    expect((await incidentRow(open.id))?.status).toBe("open");
    expect((await incidentRow(reported.id))?.status).toBe("reported");
  });
});
