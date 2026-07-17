# Sidenav shell + dedicated views — design

**Date:** 2026-07-17
**Status:** approved
**Scope:** UI only (`ui/`). No worker, API, or schema changes.

## Problem

The dashboard packs every section (analytics row, system topology, chaos, deploys,
incidents) into one 1440px grid plus a separate Chat tab. Sections are cramped —
the topology SVG and galaxy render small, chaos lives in a 380px rail, deploys is
capped at 8 rows — while wide screens leave dead whitespace around the grid. On
mobile the header nav wraps to a second row.

## Decision

Replace the two-tab shell with **six dedicated views** behind an **expandable
desktop side rail** and a **mobile bottom tab bar**:

| View | Content | Width treatment |
| --- | --- | --- |
| Overview (landing) | today's all-in-one grid, unchanged | existing 1440px grid |
| Systems | `SystemView` (topology + galaxy + service detail) | full content width; SVG/galaxy scale up |
| Chaos | `ChaosPanel` | centered ~880px; scenarios as a ~2-col grid, Restore / Reset & reseed beneath |
| Deploys | `DeploysCard` list | centered ~880px; shows every row the API returns (Overview rail keeps its 8-row cap) |
| Incidents | `IncidentsFeed` full-width; detail stays a modal | full content width |
| Chat | `ChatPanel` | taller viewport (shorter chrome), modest max width |

`WorldStatusBanner` renders above every view except Chat.

The content area keeps a centered `max-w-[1440px]` container beside the rail;
"full content width" means the full width of that container, not the viewport.

## Navigation shell

**Desktop (`lg`+):** sticky full-height left rail in the polylane language (panel
background, hairline border). Items are icon + label rows; the active item is
styled like today's active pill and carries `aria-current="page"`. A chevron at
the bottom collapses the rail to a 64px icon-only strip — labels become `title`
tooltips + `aria-label`s. Collapsed state persists to localStorage via
`lib/storage.ts` (`wt-nav-collapsed`). The Incidents item shows a count badge
when any incident is live (status `open` / `investigating` / `reported`).

**Mobile (below `lg`):** fixed bottom tab bar with all six items (icon +
~10px label), `env(safe-area-inset-bottom)` padding, and matching bottom padding
on `<main>` so content never hides behind it. No drawer.

**Header:** wordmark, theme toggle, world-status pill only. The Dashboard/Chat
pill toggle is removed (this also fixes the mobile header wrap).

**Routing:** view state syncs to the URL hash (`#/systems`, `#/chaos`, …) with a
single `hashchange` listener — deep-linkable, back/forward works, no router
dependency. Unknown or empty hash → Overview.

## State, mounting, polling

- The shared `state` / `incidents` polls stay hoisted at App level, gated off
  only while Chat is active (today's behavior, generalized to six views).
- Views render conditionally **except Chat, which stays mounted-but-hidden**:
  unmounting would kill an in-flight SSE chat stream. The other five are safe to
  unmount because `usePoll` refetches on mount.
- `AnalyticsRow` and `DeploysCard` keep their own `active`-gated polls, tied to
  their view's visibility.

## Error handling

Unchanged per panel: `LoadingCard` while loading, offline pill on fetch failure,
chaos-disabled reasons from world status. No new error surfaces.

## Testing / verification

No UI test infra exists (vitest pool targets the worker), so verification is:
`pnpm typecheck`, then `pnpm dev` checked in a browser at ~1440px and ~390px in
both light and dark themes — rail expand/collapse + persistence, hash routing +
back button, chat stream surviving navigation, bottom bar clearance.

## Out of scope

Panel-internal redesigns beyond width/grid adjustments, new data or endpoints,
UI test infrastructure, and any change to the Overview grid's composition.
