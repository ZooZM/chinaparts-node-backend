#!/usr/bin/env bash
# Reports the 95th-percentile latencies the success criteria set, from the service's own logs.
#
#   SC-004  upload to published       logged by the worker as  "publishLatencyMs"   (target: p95 under 120 s)
#   SC-010  notification to sent      logged by the worker as  "deliveryLatencyMs"  (target: p95 under 30 s)
#
# The logs stay on the server: this reads them over SSH and prints only the numbers.
#
#   ./scripts/metrics/latency-report.sh user@server /var/www/html/chinaparts-reels-backend [since]
#
# `since` is a docker duration such as 24h or 7d-in-hours (168h). Default 24h.
#
# Or run it on the server itself with no host:
#
#   ./scripts/metrics/latency-report.sh - "$PWD" 168h
set -euo pipefail

TARGET="${1:?usage: latency-report.sh <user@host|-> <deploy-path> [since]}"
DEPLOY_PATH="${2:?usage: latency-report.sh <user@host|-> <deploy-path> [since]}"
SINCE="${3:-24h}"

read_logs() {
  local command="cd '${DEPLOY_PATH}' && docker compose logs --no-color --since '${SINCE}' worker api 2>&1"
  if [ "$TARGET" = "-" ]; then bash -c "$command"; else ssh "$TARGET" "$command"; fi
}

# Prints "<count> <p50> <p95> <max>" for the values of one field, one per input line.
percentiles() {
  sort -n | awk '
    { v[NR] = $1 }
    END {
      if (NR == 0) { print "0 - - -"; exit }
      p50 = v[int((NR - 1) * 0.50) + 1]
      p95 = v[int((NR - 1) * 0.95) + 1]
      print NR, p50, p95, v[NR]
    }'
}

LOGS="$(read_logs)"

field() {
  # `"publishLatencyMs":1234` -> 1234, from the JSON lines the worker logs.
  printf '%s\n' "$LOGS" | grep -o "\"$1\":[0-9]*" | cut -d: -f2
}

echo "window: last ${SINCE}"
printf '%-34s %8s %10s %10s %10s\n' "" "count" "p50 (ms)" "p95 (ms)" "max (ms)"
printf '%-34s %8s %10s %10s %10s\n' "SC-004 upload to published" $(field publishLatencyMs | percentiles)
printf '%-34s %8s %10s %10s %10s\n' "SC-010 notification to sent" $(field deliveryLatencyMs | percentiles)
