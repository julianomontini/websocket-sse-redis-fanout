<#
.SYNOPSIS
  Simulates a rolling restart of the client-api replicas started via
  docker-compose.replicas.yml - one at a time, waiting for each to become
  ready again before touching the next.

.DESCRIPTION
  For each client-api container: `docker restart` it (sends SIGTERM, waits
  up to -GraceSeconds for the graceful-shutdown handler in src/index.ts to
  finish, then starts it again), then polls its /readyz endpoint (via
  `docker exec ... node -e ...` - no curl/wget dependency needed, node is
  already in the image) until it answers 200 or -ReadyTimeoutSeconds
  elapses.

  Run this while something is connected through the lb service (the
  frontend, or a curl/EventSource session) to watch it migrate between
  replicas exactly like a real rolling deploy.

.EXAMPLE
  .\rolling-restart.ps1
#>

param(
  [int]$GraceSeconds = 20,
  [int]$ReadyTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"

$containers = docker compose -f docker-compose.yml -f docker-compose.replicas.yml ps -q client-api
if (-not $containers) {
  throw "No client-api containers found. Start the replicas stack first, e.g.:`n" +
        "  docker compose -f docker-compose.yml -f docker-compose.replicas.yml up -d --build --scale client-api=3"
}

Write-Host "Found $($containers.Count) client-api replica(s)."

foreach ($id in $containers) {
  $shortId = $id.Substring(0, 12)
  $name = (docker inspect --format '{{.Name}}' $id).TrimStart('/')

  Write-Host ""
  Write-Host "=== Restarting $name ($shortId) ==="
  docker restart -t $GraceSeconds $id | Out-Null

  Write-Host "Waiting for $name to become ready..."
  $deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    docker exec $id node -e "require('http').get('http://localhost:3000/readyz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }

  if (-not $ready) {
    throw "$name did not become ready within $ReadyTimeoutSeconds s - check 'docker compose logs $name'"
  }
  Write-Host "$name is ready."
}

Write-Host ""
Write-Host "Rolling restart complete - all replicas cycled, one at a time."
