#!/usr/bin/env bash
set -euo pipefail

REGISTRY="skywarp75"
IMAGE="webfrac"
TAG="${1:-latest}"

echo "==> Building ${IMAGE}:${TAG} (cache-busting git clone)..."
docker buildx build \
  --platform linux/amd64 \
  --build-arg CACHEBUST="$(date +%s)" \
  -t "${REGISTRY}/${IMAGE}:${TAG}" \
  --push \
  .

echo "==> Done. Image: ${REGISTRY}/${IMAGE}:${TAG}"
