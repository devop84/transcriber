#!/usr/bin/env bash
# Build Linux AppImage + .deb inside Docker (works from Windows/macOS/Linux with Docker).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${ELECTRON_BUILDER_IMAGE:-electronuserland/builder:18}"

echo "[pack-linux-docker] Using image $IMAGE"
docker run --rm \
  --env ELECTRON_CACHE="/root/.cache/electron" \
  --env ELECTRON_BUILDER_CACHE="/root/.cache/electron-builder" \
  -v "$ROOT":/project \
  -w /project \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    apt-get update -y
    apt-get install -y python3 python3-venv python3-pip
    npm ci
    npm run build -w @transcriber/shared
    npm run bundle:python -w @transcriber/desktop -- --platform=linux --force
    npm run build -w @transcriber/desktop
    cd apps/desktop
    npx electron-builder --linux AppImage deb --x64 --config.directories.output=release/linux
  '

echo "[pack-linux-docker] Artifacts should be under apps/desktop/release/linux/"
