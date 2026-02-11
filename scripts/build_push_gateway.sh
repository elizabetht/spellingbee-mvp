#!/usr/bin/env bash
set -euo pipefail

# Builds and pushes the gateway image into the MicroK8s registry.
# Run on a machine that can access the MicroK8s registry (often the controller).

IMAGE="localhost:32000/spellingbee-gateway:0.1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${ROOT}/gateway"
docker build -t "${IMAGE}" .
docker push "${IMAGE}"

echo "Pushed: ${IMAGE}"
