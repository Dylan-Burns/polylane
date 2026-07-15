/**
 * Area 3 (spec §11): the incident feed plus the detail view (live timeline + report). Split into
 * `panels/incidents/*` for the feed row, the live timeline, the step cards, the report renderer,
 * and the evidence trace drawer — composed here as the one entry point the rest of the app imports.
 */

import { useState } from "react";
import type { IncidentView, WorldStatus } from "../lib/types";
import { IncidentDetailModal } from "./incidents/Detail";
import { IncidentsFeed } from "./incidents/Feed";

export function IncidentsPanel({ incidents, worldStatus }: { incidents: IncidentView[]; worldStatus: WorldStatus }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <>
      <IncidentsFeed incidents={incidents} worldStatus={worldStatus} onSelect={setSelectedId} />
      {selectedId && <IncidentDetailModal incidentId={selectedId} onClose={() => setSelectedId(null)} />}
    </>
  );
}
