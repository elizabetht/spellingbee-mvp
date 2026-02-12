#!/usr/bin/env bash
# Opens a tunnel to the spellingbee UI on localhost:8080
# Usage: bash scripts/tunnel.sh [port]
set -euo pipefail

PORT="${1:-8080}"
HOST="nvidia@192.168.1.75"

# Kill any existing process on the local port
if lsof -ti:"${PORT}" &>/dev/null; then
  echo "Killing existing process on port ${PORT}..."
  lsof -ti:"${PORT}" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

echo "Tunneling spellingbee UI to http://localhost:${PORT}"
echo "Press Ctrl+C to stop"
ssh -L "${PORT}:127.0.0.1:8080" "${HOST}" \
  "microk8s kubectl -n spellingbee port-forward svc/spellingbee-ui 8080:8080"
