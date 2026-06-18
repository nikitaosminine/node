#!/usr/bin/env bash
# Fail if the HTTP fetch handler uses the service-role client outside health/debug routes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILE="$ROOT/src/index.ts"

fetch_start=$(grep -n 'async fetch(request: Request, env: Env)' "$FILE" | head -1 | cut -d: -f1)
scheduled_start=$(grep -n 'async scheduled(controller: ScheduledController' "$FILE" | head -1 | cut -d: -f1)
fetch_block=$(sed -n "${fetch_start},$((scheduled_start - 1))p" "$FILE")

violations=$(echo "$fetch_block" | grep -n 'adminDb(env)' | grep -Ev 'health|_debug|GET /api/health' || true)

# Allow adminDb only on the health check and debug sections.
allowed=$(echo "$fetch_block" | awk '
  /GET \/api\/health/ { allow=1 }
  /Debug endpoints/ { allow=1 }
  /Feed read endpoints/ { allow=0 }
  allow && /adminDb\(env\)/ { next }
  /adminDb\(env\)/ { print NR ": " $0 }
')

if [ -n "$allowed" ]; then
  echo "Service-role client used in user-facing fetch routes:"
  echo "$allowed"
  exit 1
fi

echo "OK: fetch handler uses userDb for authenticated routes."
