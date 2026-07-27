#!/usr/bin/env bash
set -euo pipefail
cd /mnt/c/Devop/transcriber
echo "[linux-pack] node=$(node -v) npm=$(npm -v)"
npm run build -w @transcriber/shared
node scripts/bundle-python-runtime.mjs --platform=linux --force
npm run build -w @transcriber/desktop
cd apps/desktop
npx electron-builder --linux AppImage deb --x64 --projectDir . --config.directories.output=release/linux
echo "[linux-pack] done"
ls -lh release/linux
