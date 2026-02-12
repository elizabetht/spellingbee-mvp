#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-0.1}"
IMAGE="localhost:32000/spellingbee-ui:${TAG}"

echo "Building UI image: ${IMAGE}"
cd "$(dirname "$0")/../ui"
docker build -t "${IMAGE}" .
docker push "${IMAGE}"
echo "Pushed ${IMAGE}"
