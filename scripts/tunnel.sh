#!/usr/bin/env bash
# Opens a tunnel to the spellingbee UI on localhost:8080
# Usage: bash scripts/tunnel.sh [port]
set -uo pipefail

PORT="${1:-8080}"
HOST="nvidia@192.168.1.75"

# Kill any existing process on the local port
lsof -ti:"${PORT}" 2>/dev/null | xargs kill -9 2>/dev/null || true

# Kill any stale kubectl port-forward on the remote host
ssh "${HOST}" 'kill $(pgrep -f "port-forward svc/spellingbee-ui") 2>/dev/null' 2>/dev/null || true
sleep 2

echo "Tunneling spellingbee UI to http://localhost:${PORT}"
echo "Press Ctrl+C to stop"
ssh -L "${PORT}:127.0.0.1:8080" "${HOST}" \
  "microk8s kubectl -n spellingbee port-forward svc/spellingbee-ui 8080:8080"
