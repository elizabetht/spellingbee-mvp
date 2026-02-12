#!/usr/bin/env bash
set -euo pipefail
#
# Deploy script for SpellingBee MVP.
#
# Usage:
#   ./scripts/deploy.sh              # auto-detect changed components & deploy
#   ./scripts/deploy.sh --all        # rebuild + deploy everything
#   ./scripts/deploy.sh ui gateway   # rebuild + deploy only named components
#
# Must be run on the controller node (or wherever Docker can push to
# localhost:32000, the MicroK8s built-in registry).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KUBECTL="microk8s kubectl"
REGISTRY="localhost:32000"
NAMESPACE="spellingbee"

# ── component definitions ─────────────────────────────────────────────
# Map: component → build context dir, image name, k8s deployment name
declare -A CTX=( [ui]=ui [gateway]=gateway [asr]=asr )
declare -A IMG=( [ui]=spellingbee-ui [gateway]=spellingbee-gateway [asr]=spellingbee-asr )
declare -A DEP=( [ui]=spellingbee-ui [gateway]=spellingbee-gateway [asr]=spellingbee-asr )

# ── helpers ────────────────────────────────────────────────────────────
red()   { printf '\033[1;31m%s\033[0m\n' "$*"; }
green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[1;34m%s\033[0m\n' "$*"; }

timestamp_tag() {
  date +"%Y%m%d-%H%M%S"
}

build_and_push() {
  local comp="$1"
  local tag
  tag=$(timestamp_tag)
  local image="${REGISTRY}/${IMG[$comp]}:${tag}"
  local ctx="${ROOT}/${CTX[$comp]}"

  blue "▶ Building ${comp} → ${image}"
  docker build -t "${image}" "${ctx}"
  docker push "${image}"
  green "  ✓ Pushed ${image}"

  # Update the k8s manifest with the new tag
  # Match the image line for this component regardless of current tag
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s|${REGISTRY}/${IMG[$comp]}:[^ ]*|${image}|g" "${ROOT}/k8s/spellingbee.yaml"
  else
    sed -i "s|${REGISTRY}/${IMG[$comp]}:[^ ]*|${image}|g" "${ROOT}/k8s/spellingbee.yaml"
  fi
  blue "  ✓ Updated k8s/spellingbee.yaml → ${image}"

  echo "${comp}"
}

rollout_restart() {
  local comp="$1"
  blue "▶ Restarting deployment/${DEP[$comp]}"
  ${KUBECTL} rollout restart "deployment/${DEP[$comp]}" -n "${NAMESPACE}"
}

wait_for_rollout() {
  local comp="$1"
  blue "▶ Waiting for deployment/${DEP[$comp]}..."
  ${KUBECTL} rollout status "deployment/${DEP[$comp]}" -n "${NAMESPACE}" --timeout=120s
  green "  ✓ ${DEP[$comp]} is ready"
}

# ── detect changed components via git diff ─────────────────────────────
detect_changed() {
  local changed=()
  cd "${ROOT}"

  # Compare working tree + staged against the last deployed commit.
  # Use HEAD~1 if there's a recent commit, otherwise diff against HEAD.
  local ref="HEAD"
  if git rev-parse HEAD~1 >/dev/null 2>&1; then
    ref="HEAD~1"
  fi

  local files
  files=$(git diff --name-only "${ref}" HEAD 2>/dev/null || true)
  files+=$'\n'
  files+=$(git diff --name-only 2>/dev/null || true)
  files+=$'\n'
  files+=$(git diff --cached --name-only 2>/dev/null || true)

  for comp in ui gateway asr; do
    if echo "${files}" | grep -q "^${CTX[$comp]}/"; then
      changed+=("${comp}")
    fi
  done

  # Also check if k8s manifest itself changed (apply it even if no rebuild)
  if echo "${files}" | grep -q "^k8s/"; then
    K8S_CHANGED=true
  fi

  echo "${changed[@]}"
}

# ── main ───────────────────────────────────────────────────────────────
K8S_CHANGED=false
COMPONENTS=()

if [[ "${1:-}" == "--all" ]]; then
  COMPONENTS=(ui gateway asr)
  K8S_CHANGED=true
  blue "Mode: rebuild ALL components"
elif [[ $# -gt 0 ]]; then
  COMPONENTS=("$@")
  K8S_CHANGED=true
  blue "Mode: rebuild specified components: ${COMPONENTS[*]}"
else
  blue "Mode: auto-detect changes"
  read -ra COMPONENTS <<< "$(detect_changed)"
  if [[ ${#COMPONENTS[@]} -eq 0 && "${K8S_CHANGED}" == "false" ]]; then
    green "No changes detected in ui/, gateway/, asr/, or k8s/. Nothing to deploy."
    exit 0
  fi
  if [[ ${#COMPONENTS[@]} -gt 0 ]]; then
    blue "Changed components: ${COMPONENTS[*]}"
  fi
fi

# Validate component names
for comp in "${COMPONENTS[@]}"; do
  if [[ -z "${CTX[$comp]:-}" ]]; then
    red "Unknown component: ${comp}  (valid: ui, gateway, asr)"
    exit 1
  fi
done

# Build & push changed images
BUILT=()
for comp in "${COMPONENTS[@]}"; do
  build_and_push "${comp}"
  BUILT+=("${comp}")
done

# Apply k8s manifest
if [[ "${K8S_CHANGED}" == "true" || ${#BUILT[@]} -gt 0 ]]; then
  blue "▶ Applying k8s/spellingbee.yaml"
  ${KUBECTL} apply -f "${ROOT}/k8s/spellingbee.yaml"
  green "  ✓ Manifest applied"
fi

# Rollout restart for rebuilt components
for comp in "${BUILT[@]}"; do
  rollout_restart "${comp}"
done

# Wait for all rollouts
for comp in "${BUILT[@]}"; do
  wait_for_rollout "${comp}"
done

# Summary
echo ""
green "═══════════════════════════════════════"
if [[ ${#BUILT[@]} -gt 0 ]]; then
  green "  Deployed: ${BUILT[*]}"
else
  green "  Manifest applied (no images rebuilt)"
fi
green "═══════════════════════════════════════"
