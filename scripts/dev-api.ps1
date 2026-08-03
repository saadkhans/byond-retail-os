# Starts the BYOND API for local development on Windows, first freeing the
# API port if a previous (often orphaned) dev server still holds it.
#
# Why this exists: `nest start --watch` on Windows can leave an orphaned
# node.exe listening on the port after its terminal is closed, so the next
# start fails with "EADDRINUSE: address already in use :::3000" — or worse,
# the OLD build keeps serving and the frontend talks to stale code.
#
# Usage (from the repo root):
#   .\scripts\dev-api.ps1                 # free port 3000, then start the API
#   .\scripts\dev-api.ps1 -Port 3001      # run the API on a different port
#   .\scripts\dev-api.ps1 -KillOnly       # just free the port, don't start
#
# Or via pnpm: pnpm run dev:api
param(
    [int]$Port = 3000,
    [switch]$KillOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listeners) {
    $ownerPids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($ownerPid in $ownerPids) {
        $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        # Only auto-kill node processes (the stale dev server). Anything else
        # holding the port is unexpected — surface it instead of killing it.
        if ($proc.ProcessName -eq 'node') {
            # `nest start --watch` runs a supervisor chain (pnpm → cmd shim →
            # nest CLI → cmd shim → node dist/main) that RESPAWNS the server
            # if only the listening child is killed. Walk up through node and
            # cmd ancestors and stop the whole tree, TOP-DOWN, so nothing is
            # left alive to respawn it. Stop at the first other ancestor (the
            # terminal/shell) — and never touch this script's own ancestry.
            $ownAncestors = @()
            $cur = $PID
            for ($i = 0; $i -lt 10; $i++) {
                $info = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
                if (-not $info -or -not $info.ParentProcessId) { break }
                $ownAncestors += $info.ParentProcessId
                $cur = $info.ParentProcessId
            }

            $chain = @()
            $cur = $ownerPid
            for ($i = 0; $i -lt 8; $i++) {
                $info = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
                if (-not $info) { break }
                $parent = Get-Process -Id $info.ParentProcessId -ErrorAction SilentlyContinue
                if (-not $parent -or $parent.ProcessName -notin @('node', 'cmd')) { break }
                if ($ownAncestors -contains $parent.Id) { break }
                $chain += $parent.Id
                $cur = $parent.Id
            }
            [array]::Reverse($chain)
            foreach ($ancestorPid in $chain) {
                Write-Host "Stopping supervisor process (PID $ancestorPid) of the stale dev server"
                Stop-Process -Id $ancestorPid -Force -ErrorAction SilentlyContinue
            }
            Write-Host "Stopping stale node process (PID $ownerPid) listening on port $Port"
            Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
        }
        else {
            Write-Error ("Port $Port is held by '$($proc.ProcessName)' (PID $ownerPid), " +
                "which is not a node dev server. Stop it manually or pick another " +
                "port: .\scripts\dev-api.ps1 -Port 3001")
        }
    }
    # Give the OS a moment to release the socket.
    Start-Sleep -Milliseconds 500
}
else {
    Write-Host "Port $Port is free."
}

if ($KillOnly) { exit 0 }

# process.env takes precedence over services/api/.env, so -Port works even
# though the .env file pins PORT=3000. The frontend must point at the same
# port via apps/admin-web/.env → VITE_API_BASE_URL.
$env:PORT = "$Port"
if ($Port -ne 3000) {
    Write-Host "NOTE: set VITE_API_BASE_URL=http://127.0.0.1:$Port in apps/admin-web/.env and restart Vite."
}

Write-Host "Starting API on http://127.0.0.1:$Port ..."
Set-Location $repoRoot
pnpm --filter @byond/api start:dev
