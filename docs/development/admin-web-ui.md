# Admin web UI (Phase 23)

The admin app (`apps/admin-web`) is a single React + Vite app with one
global stylesheet (`src/styles.css`), a shared UI kit under `src/ui/`, and
one `Page` chrome component every routed page uses.

## Navigation groups

The sidebar is grouped by the job being done. Every list page appears
exactly once (pinned by `src/nav.spec.ts`).

| Group | Pages |
| --- | --- |
| Overview | Dashboard |
| Store operations | Stores, Units, Devices, Catalog, Inventory |
| Commerce | Checkout sessions, Orders, Payments, Payment events, Reconciliation |
| Vision review | Review queue, Journeys, CV events, Inference jobs |
| Clip lab | Clip Lab, Test videos, Reference library, One SKU bootstrap, Pretrained vision & planograms |
| Cameras & pilots | Cameras, Camera calibration, Camera runs, Pilot evaluations, Test protocols |
| Evaluation & datasets | CV Evaluation, Dataset improvement |

The sidebar collapses to icons (state remembered in `localStorage` key
`byond.admin.sidebar`) and becomes a drawer under 900 px.

## Merged and moved pages

Nothing was removed; overlapping entry points were consolidated and the old
routes redirect so bookmarks keep working.

| Old route | Now |
| --- | --- |
| `/pickup-validation` | Tab "Legacy validation" on `/cv-evaluation` (`?tab=validation`) |
| `/pilot-runs` (list) | `/camera-runs?type=replay` — one list for replays and live sessions |
| `/live-sessions` (list) | `/camera-runs?type=live` |
| `/pilot-runs/:id`, `/live-sessions/:id` | Unchanged detail pages (stop / polling / performance for live, stage timings for replay) |

Other consolidation:

- **Pretrained vision & planograms** keeps the provider chips, the
  comparison report and the planogram editor. Its clip evaluation now uses
  the clip's upload-time binding by default (store, rack, rack region);
  the previous manual inputs sit under "Advanced overrides". Upload,
  screening and one-click analysis live in Clip Lab.
- **Test videos** keeps artifacts, crops, deletion and the detection and
  fusion evidence panels. Its unbound upload form is collapsed under
  "Upload without rack binding (advanced)" with a link to Clip Lab.

## Theme

Three states: System (default, nothing stamped), Light, Dark. The choice is
stored in `localStorage` key `byond.admin.theme` and stamped as
`data-theme` on `<html>` by a tiny inline script in `index.html` before
first paint, then kept in sync by the `ThemeSwitch` in the top bar. All
colours are CSS tokens on `:root`; the dark palette redefines only tokens,
once for `prefers-color-scheme: dark` (guarded so an explicit light choice
wins) and once for `[data-theme="dark"]`. Components never use literal
colours.

Type: Instrument Sans for the UI, IBM Plex Mono for ids, SKUs, codes and
timestamps.

## Shared UI kit (`src/ui/`)

`AppShell`, `Sidebar`, `TopBar`, `ThemeSwitch`, `PageHeader`, `Section`,
`Card`, `StatTiles`, `DataTable`, `Pagination`, `Badge`, `Notice`,
`EmptyState`, `FormRow`, `Field` (required marker), `Disclosure`, `Tabs`.
All are re-exported from `src/components.tsx`, alongside the unchanged
`useLoad`, `useDebounced`, `StatusBadge`, `Page` and `formatDate`.

## Safety specs

Three static specs read page source text and pin operator labels and
forbidden tokens (`clip-lab-page-safety.spec.ts`,
`one-sku-bootstrap-page-safety.spec.ts`,
`pretrained-vision-page-safety.spec.ts`). A restyle may move markup and
classes freely but must keep those literal strings.
