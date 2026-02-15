#!/usr/bin/env bash
set -euo pipefail

REGISTRY="skywarp75"
IMAGE="fractal"

usage() {
  cat <<'HELP'
Usage:
  bash deploy.sh                Build HEAD of main → :experimental
  bash deploy.sh 1.2.0         Build from git tag v1.2.0 → :1.2.0 + :latest

Examples:
  bash deploy.sh               # push experimental for testing
  bash deploy.sh 1.2.0         # promote v1.2.0 as stable release
HELP
  exit 1
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
fi

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  # ── Experimental: build from HEAD of main ──
  GIT_REF="main"
  TAGS=("-t" "${REGISTRY}/${IMAGE}:experimental")
  echo "==> Building experimental from main HEAD..."
else
  # ── Release: build from a git tag ──
  GIT_REF="v${VERSION}"
  TAGS=("-t" "${REGISTRY}/${IMAGE}:${VERSION}" "-t" "${REGISTRY}/${IMAGE}:latest")
  echo "==> Building release ${VERSION} from tag ${GIT_REF}..."
fi

docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --sbom=false \
  --build-arg CACHEBUST="$(date +%s)" \
  --build-arg GIT_REF="${GIT_REF}" \
  "${TAGS[@]}" \
  --push \
  .

echo "==> Done."
