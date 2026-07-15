-- Spec §8 v2.1: baselines now cover FOUR metrics — req_rate, error_rate, p95, p50 — because the
-- latency rules pair their p95 ratio threshold with a p50 distribution-shift confirmation
-- (p50 >= 1.5x its own baseline), which needs a p50 baseline row to compare against.
--
-- `baselines` is a derived cache (recomputed every 15 min from the trailing 24h of rollups, and
-- synchronously at the end of backfill — spec §8), so drop-and-recreate is safe: the next
-- `computeBaselines` run fully repopulates it, now including p50 rows. Same natural PK as 0001.

DROP TABLE baselines;

CREATE TABLE baselines (
  service TEXT NOT NULL,
  operation TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('req_rate', 'error_rate', 'p95', 'p50')),
  median REAL NOT NULL,
  mad REAL NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (service, operation, metric)
);
