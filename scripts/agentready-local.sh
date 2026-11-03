#!/usr/bin/env bash
# Local isitagentready parity (Websmith §5 Part C verify column). 15 scored checks.
# Prints N/15. Exits 0 only at 14/15 with dnsAid the only miss (Card B owns 12-14).
# Usage: scripts/agentready-local.sh [base-url]
# With no URL, starts wrangler dev on PORT (default 8799) against a fresh build.
set -u
cd "$(dirname "$0")/.."
PORT="${PORT:-8799}"
LOG=$(mktemp)
PID=
if [[ $# -ge 1 ]]; then
  BASE="${1%/}"
  OWN=0
else
  BASE="http://127.0.0.1:$PORT"
  OWN=1
  if [[ ! -f dist/_worker.js/index.js ]]; then
    echo "agentready-local: dist/ missing; run pnpm build first" >&2
    exit 2
  fi
  W="npx --yes wrangler@4.123.0"
  LOCAL_COMPAT="${LOCAL_COMPAT:-2026-08-18}"
  LITE=$(mktemp -d)
  # HTML bot pages are thousands of directories and stall the assets watcher. Keep the JSON API.
  rsync -a --exclude='/bots/' --exclude='/categories/' dist/ "$LITE/"
  $W d1 migrations apply grokbot-zone --local >/dev/null
  $W dev --port "$PORT" --compatibility-date "$LOCAL_COMPAT" --assets "$LITE" >"$LOG" 2>&1 &
  PID=$!
  ready=0
  for _ in $(seq 1 90); do
    if curl -sf -o /dev/null "$BASE/api/health"; then ready=1; break; fi
    sleep 1
  done
  if [[ "$ready" != 1 ]]; then
    echo "agentready-local: wrangler dev did not start" >&2
    cat "$LOG" >&2
    kill "$PID" 2>/dev/null || true
    exit 2
  fi
fi
cleanup() {
  if [[ "${OWN:-0}" == 1 && -n "${PID:-}" ]]; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill $(lsof -ti "tcp:$PORT" -sTCP:LISTEN) 2>/dev/null || true
  fi
}
trap cleanup EXIT
python3 scripts/agentready_probe.py "$BASE"
status=$?
if [[ "$OWN" == 1 ]]; then echo "wrangler log: $LOG"; fi
exit "$status"
