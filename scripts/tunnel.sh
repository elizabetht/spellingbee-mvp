#!/usr/bin/env bash
# Opens a tunnel to the spellingbee UI on localhost:8080
# Usage: bash scripts/tunnel.sh
set -euo pipefail

PORT="${1:-8080}"
HOST="nvidia@192.168.1.75"

echo "Tunneling spellingbee UI to http://localhost:${PORT}"
echo "Press Ctrl+C to stop"
ssh -L "${PORT}:127.0.0.1:8080" "${HOST}" \
  "microk8s kubectl -n spellingbee port-forward svc/spellingbee-ui 8080:8080"
