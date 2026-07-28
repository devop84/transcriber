#!/usr/bin/env bash
# Fast Linux AppImage pack: build on WSL ext4 (not /mnt/c), AppImage only (no .deb).
set -euo pipefail

SRC="/mnt/c/Devop/transcriber"
WORK="${HOME}/transcriber-linux-pack"
OUT_WIN="${SRC}/apps/desktop/release/linux"

echo "[fast-linux] workdir=${WORK}"
rm -rf "${WORK}"
mkdir -p "${WORK}/apps/desktop" "${WORK}/services"

echo "[fast-linux] copying app bits to WSL disk…"
cp -a "${SRC}/apps/desktop/package.json" "${WORK}/apps/desktop/"
cp -a "${SRC}/apps/desktop/dist" "${WORK}/apps/desktop/"
cp -a "${SRC}/apps/desktop/dist-electron" "${WORK}/apps/desktop/"
# python-runtime is large; copy once onto ext4 for fast packaging I/O
cp -a "${SRC}/apps/desktop/resources" "${WORK}/apps/desktop/"

echo "[fast-linux] copying stt-local (no .venv)…"
mkdir -p "${WORK}/services/stt-local"
# Prefer rsync when available; otherwise cp + prune.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.venv' \
    --exclude '__pycache__' \
    --exclude 'python-runtime' \
    "${SRC}/services/stt-local/" "${WORK}/services/stt-local/"
else
  cp -a "${SRC}/services/stt-local/." "${WORK}/services/stt-local/"
  rm -rf "${WORK}/services/stt-local/.venv" \
    "${WORK}/services/stt-local/python-runtime" \
    "${WORK}/services/stt-local/"**/__pycache__
fi

cd "${WORK}/apps/desktop"
echo "[fast-linux] installing electron-builder (local)…"
npm install --no-fund --no-audit --no-fund electron@34.3.0 electron-builder@25.1.8

echo "[fast-linux] packaging AppImage only…"
npx electron-builder --linux AppImage --x64 --projectDir . --config.directories.output=release/linux

mkdir -p "${OUT_WIN}"
cp -f release/linux/*.AppImage "${OUT_WIN}/"
echo "[fast-linux] done:"
ls -lh "${OUT_WIN}"/*.AppImage
