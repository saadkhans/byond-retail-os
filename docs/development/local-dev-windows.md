# Local development on Windows (API + admin web + video ingestion)

This guide is the reliable startup path for Windows/PowerShell, including the
Phase 10 controlled test-video upload flow. All commands run from the repo
root unless noted.

## TL;DR

```powershell
# 1. Database must be listening on 5433 (see "Database" below)
# 2. Start the API (frees port 3000 first if a stale process holds it)
pnpm run dev:api

# 3. In a second terminal — start the admin web app
pnpm --filter @byond/admin-web dev

# 4. Verify
Invoke-RestMethod http://127.0.0.1:3000/health
```

## Prerequisites

- Node.js >= 22 and pnpm 10.x (`corepack enable` or `npm i -g pnpm`)
- PostgreSQL reachable at `localhost:5433` (local install or Docker)
- Optional, for real Phase 10 media tooling: `ffmpeg`/`ffprobe` and
  `tesseract` on `PATH` (otherwise uploads fail closed — see
  [Video ingestion](#upload-a-controlled-test-video))

## Database (port 5433)

The local API expects:

```
DATABASE_URL=postgresql://byond:byond@localhost:5433/byond_dev
```

If you use Docker, a matching container is:

```powershell
docker run -d --name byond-postgres -p 5433:5432 `
  -e POSTGRES_USER=byond -e POSTGRES_PASSWORD=byond -e POSTGRES_DB=byond_dev `
  postgres:16
# later: docker start byond-postgres
```

Verify it is up:

```powershell
Test-NetConnection 127.0.0.1 -Port 5433
```

Apply migrations (and optionally seed) from the repo root:

```powershell
pnpm --filter @byond/api prisma:migrate
pnpm --filter @byond/api db:seed   # requires the SEED_* vars in services/api/.env
```

## API environment (`services/api/.env`)

Copy `services/api/.env.example` to `services/api/.env` if you have not
already, then make sure it contains:

```
DATABASE_URL=postgresql://byond:byond@localhost:5433/byond_dev
PORT=3000
NODE_ENV=development
VIDEO_TEST_MEDIA_INGEST_ENABLED=true
VIDEO_FFMPEG_ENABLED=true
VIDEO_OCR_ENABLED=true
JWT_SECRET=<generate: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
JWT_EXPIRES_IN=15m
CORS_ORIGINS=http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174
```

Two things bite people here:

- **CORS is an exact-origin allowlist.** `http://127.0.0.1:5174` and
  `http://localhost:5174` are *different* origins, and Vite silently moves
  from 5173 to 5174 when 5173 is busy. If the browser origin is not in
  `CORS_ORIGINS`, every request fails and the UI shows
  "Cannot reach the API" even though the API is healthy. List all the
  localhost/127.0.0.1 + 5173/5174 combinations as above.
- **`VIDEO_TEST_MEDIA_INGEST_ENABLED=true` requires
  `NODE_ENV=development` (or `test`)** — the API refuses to boot otherwise.

`.env` is loaded from `services/api/` (the package working directory), so
always start the API through pnpm's filter (or the dev script), never with a
bare `nest start` from the repo root.

## Start the API

```powershell
pnpm run dev:api
```

This runs `scripts/dev-api.ps1`, which:

1. Finds any process listening on port 3000. A stale `node.exe` (an orphaned
   `nest start --watch` from a closed terminal) is killed automatically —
   **including its supervisor chain** (`pnpm → cmd → nest CLI → cmd → node`):
   killing only the listening child is not enough, because a still-alive
   watch supervisor respawns it on the next rebuild. A non-node process
   holding the port is reported instead of killed.
2. Starts `pnpm --filter @byond/api start:dev`.

If you prefer the raw commands:

```powershell
# Free port 3000 manually (only if EADDRINUSE):
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# Start the API:
pnpm --filter @byond/api start:dev
```

To run on a different port instead of killing the holder:

```powershell
.\scripts\dev-api.ps1 -Port 3001
# then set apps/admin-web/.env → VITE_API_BASE_URL=http://127.0.0.1:3001
# and restart the Vite dev server (Vite only reads .env at startup).
```

## Start the admin web app

```powershell
pnpm --filter @byond/admin-web dev
```

`apps/admin-web/.env` must point at the API:

```
VITE_API_BASE_URL=http://127.0.0.1:3000
```

Note the URL Vite prints (5173 or 5174, localhost or 127.0.0.1) — that exact
origin must be present in the API's `CORS_ORIGINS`.

## Verify

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
# expect: status ok
```

Swagger UI (non-production only): http://127.0.0.1:3000/docs

Then open the admin app (e.g. http://127.0.0.1:5174), log in, and confirm no
"Cannot reach the API" banner appears.

## Upload a controlled test video

1. Log in as a user with video-ingest access (platform admins are resolved to
   the seeded `platform-sandbox` tenant).
2. Open **Test Videos** (`/video-assets`).
3. Upload a short, controlled internal test clip (default ceiling 50 MiB,
   ~30 s / ~900 frames — longer clips are rejected with a 400 before any byte
   is stored).

Requirements for uploads to succeed:

- `VIDEO_TEST_MEDIA_INGEST_ENABLED=true` (and `NODE_ENV=development`).
- Real `ffmpeg`/`ffprobe` **and** `tesseract` (with `eng.traineddata`)
  available, with `VIDEO_FFMPEG_ENABLED=true` and `VIDEO_OCR_ENABLED=true`:
  every upload is OCR-screened frame-by-frame *before* storage, and the
  simulated recognizer cannot read pixels, so without real tooling uploads
  fail closed with a 503. There is no bypass.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `EADDRINUSE :::3000` on API start | Stale node process from a closed terminal still holds the port | `pnpm run dev:api` (kills it automatically), or `.\scripts\dev-api.ps1 -KillOnly` |
| UI shows "Cannot reach the API at http://127.0.0.1:3000" | API not running, or it crashed at boot | Check the API terminal; `Invoke-RestMethod http://127.0.0.1:3000/health` |
| Same banner, but `/health` works in PowerShell | Browser origin missing from `CORS_ORIGINS` (5173 vs 5174, localhost vs 127.0.0.1) | Add the exact origin Vite printed to `CORS_ORIGINS` in `services/api/.env`, restart the API |
| API exits immediately with `Invalid environment configuration: ...` | Missing/invalid var in `services/api/.env` (the message lists property names) | Fix the listed vars; `JWT_SECRET` needs 32+ non-placeholder chars |
| API refuses to boot mentioning `VIDEO_TEST_MEDIA_INGEST_ENABLED` | `NODE_ENV` is not `development`/`test` | Set `NODE_ENV=development` in `services/api/.env` |
| Uploads return 503 | Real ffmpeg/tesseract tooling not available while the ingest gate requires screening | Install ffmpeg + tesseract (with `eng.traineddata`) and enable both flags |
| DB connection errors at boot | Postgres not listening on 5433 | `docker start byond-postgres` (or start your local service), verify with `Test-NetConnection 127.0.0.1 -Port 5433` |
| `prisma generate` fails with `EPERM: operation not permitted, rename ... query_engine-windows.dll.node` | A running API process (including a stale/orphaned one) has the Prisma query-engine DLL loaded; Windows cannot replace a loaded DLL. `test`, `typecheck`, and `build` all run `prisma generate` first, so they hit this while any API instance is up | Stop the API (`.\scripts\dev-api.ps1 -KillOnly` kills the listener *and* its watch supervisors), run the tests/typecheck, then start it again. If it persists, find the holder: `Get-Process node \| Where-Object { try { $_.Modules.FileName -like '*query_engine-windows*' } catch { $false } }` |
