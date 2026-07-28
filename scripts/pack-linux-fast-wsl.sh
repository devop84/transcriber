#!/usr/bin/env bash
# Fast Linux AppImage pack: WSL ext4 workdir, AppImage only (no .deb).
set -euo pipefail

SRC="/mnt/c/Devop/transcriber"
WORK="${HOME}/transcriber-linux-pack"
OUT="${SRC}/apps/desktop/release/linux"

echo "[fast-linux] workdir=${WORK}"
rm -rf "${WORK}"
mkdir -p "${WORK}/apps/desktop" "${WORK}/services/stt-local" "${OUT}"

echo "[fast-linux] copying dist + resources to WSL disk…"
cp -a "${SRC}/apps/desktop/dist" "${WORK}/apps/desktop/"
cp -a "${SRC}/apps/desktop/dist-electron" "${WORK}/apps/desktop/"
cp -a "${SRC}/apps/desktop/resources" "${WORK}/apps/desktop/"

echo "[fast-linux] copying stt-local…"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.venv' --exclude '__pycache__' --exclude 'python-runtime' \
    "${SRC}/services/stt-local/" "${WORK}/services/stt-local/"
else
  cp -a "${SRC}/services/stt-local/." "${WORK}/services/stt-local/"
  rm -rf "${WORK}/services/stt-local/.venv" "${WORK}/services/stt-local/python-runtime"
  find "${WORK}/services/stt-local" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
fi

# Standalone package.json — no workspace deps (avoids npm 404 on @transcriber/shared)
cat > "${WORK}/apps/desktop/package.json" <<'EOF'
{
  "name": "transcriber-desktop",
  "version": "0.1.0",
  "private": true,
  "description": "Live meeting transcriber desktop app",
  "author": "Transcriber",
  "homepage": "https://github.com/transcriber/transcriber",
  "main": "dist-electron/main.js",
  "dependencies": {},
  "devDependencies": {
    "electron": "34.3.0",
    "electron-builder": "25.1.8"
  },
  "build": {
    "appId": "com.transcriber.app",
    "productName": "Transcriber",
    "electronVersion": "34.3.0",
    "directories": { "output": "release/linux" },
    "files": ["dist/**/*", "dist-electron/**/*", "package.json"],
    "extraResources": [
      {
        "from": "../../services/stt-local",
        "to": "stt-local",
        "filter": ["**/*", "!__pycache__/**", "!.venv/**", "!python-runtime/**"]
      },
      {
        "from": "resources/python-runtime",
        "to": "python-runtime",
        "filter": ["**/*"]
      }
    ],
    "linux": {
      "target": ["AppImage"],
      "category": "AudioVideo",
      "maintainer": "Transcriber",
      "synopsis": "Live meeting transcription with speaker labels",
      "description": "Standalone live meeting transcriber with local/cloud engines and AI analysis.",
      "artifactName": "${productName}-${version}-${arch}.${ext}"
    }
  }
}
EOF

cd "${WORK}/apps/desktop"
echo "[fast-linux] npm install electron-builder…"
npm install --no-fund --no-audit --no-fund

echo "[fast-linux] packaging AppImage…"
npx electron-builder --linux AppImage --x64 --projectDir .

mkdir -p "${OUT}"
cp -f release/linux/*.AppImage "${OUT}/"
echo "[fast-linux] done → ${OUT}"
ls -lh "${OUT}"/*.AppImage
