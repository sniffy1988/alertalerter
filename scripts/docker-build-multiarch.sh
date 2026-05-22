#!/usr/bin/env bash
# Build and push multi-arch image (amd64 + arm64) for Mac mini / Proxmox / etc.
# Usage: IMAGE=ghcr.io/you/alertscrapper ./scripts/docker-build-multiarch.sh [--push]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IMAGE="${IMAGE:-ghcr.io/sniffy1988/alertalerter:latest}"
PUSH=false
for arg in "$@"; do
  if [ "$arg" = "--push" ]; then
    PUSH=true
  fi
done

docker buildx create --name alertscrapper-builder --use 2>/dev/null \
  || docker buildx use alertscrapper-builder

ARGS=(
  --platform linux/amd64,linux/arm64
  -t "$IMAGE"
  --progress=plain
)

if [ "$PUSH" = true ]; then
  ARGS+=(--push)
else
  ARGS+=(--load)
  echo "Note: --load only loads a single arch locally. Use --push for multi-arch registry upload."
fi

docker buildx build "${ARGS[@]}" .

if [ "$PUSH" = true ]; then
  echo "Pushed multi-arch image: $IMAGE"
  echo "On Mac mini: docker compose pull && docker compose up -d"
fi
