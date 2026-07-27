# BYOND Admin Web Shell

Functional admin visibility over the BYOND API: dashboard, stores, retail
units, devices (with heartbeat status and last-seen), read-only catalog and
inventory-level views, plus checkout sessions and orders (Phase 5) with a
minimal manual test flow — create a session, add/update/remove basket lines,
and complete it into an order. Orders show no payment state: Phase 5 is the
order foundation only, and evidence/source IDs shown on sessions, lines, and
orders are vendor-neutral placeholders for future CV/VLM adapters.
Inference jobs (Phase 9) add a provider-neutral queue view with a simulated
create → start → complete/fail flow and conversion into a CV event — no real
model runs and no raw media, only safe descriptors.
Test videos (Phase 10) add controlled test-clip upload (allowlisted
containers, conservative size limit), validate/extract-frames/manual-crop
actions, an artifacts view, and per-crop inference-job creation linking into
the Phase 9 queue — metadata only: no video preview, no download URLs, and
no storage paths exist in the API by design.
Deliberately unpolished — the scope is visibility, not UI product work.

## Run locally

```bash
# from the repo root
pnpm install

cd apps/admin-web
cp .env.example .env   # VITE_API_BASE_URL (default http://localhost:3000)
pnpm run dev           # http://localhost:5173
```

The backend must be running (see the repo README). Its CORS allowlist
defaults to `http://localhost:5173`; set `CORS_ORIGINS` on the API if you
serve this app elsewhere.

## Sign-in

- **Email + password** — calls `POST /auth/login` on the API.
- **Access token** — paste an existing Bearer token instead (useful before a
  full login UI ships or when testing a specific user's permissions).

The token is kept in `localStorage` and sent only as an `Authorization`
header; it is never logged or placed in URLs.

## Checks

```bash
pnpm run typecheck   # tsc --noEmit
pnpm run build       # typecheck + vite production build
```

Both run in the workspace-wide `pnpm run typecheck` / `pnpm run build`.
