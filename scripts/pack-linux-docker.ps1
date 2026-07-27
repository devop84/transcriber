# Build Linux AppImage + .deb via Docker (from Windows PowerShell / pwsh).
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Image = if ($env:ELECTRON_BUILDER_IMAGE) { $env:ELECTRON_BUILDER_IMAGE } else { "electronuserland/builder:18" }

Write-Host "[pack-linux-docker] Using image $Image"
docker run --rm `
  -e ELECTRON_CACHE=/root/.cache/electron `
  -e ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder `
  -v "${Root}:/project" `
  -w /project `
  $Image `
  bash -lc @'
set -euo pipefail
apt-get update -y
apt-get install -y python3 python3-venv python3-pip
npm ci
npm run build -w @transcriber/shared
node scripts/bundle-python-runtime.mjs --platform=linux --force
npm run build -w @transcriber/desktop
cd apps/desktop
npx electron-builder --linux AppImage deb --x64 --config.directories.output=release/linux
'@

Write-Host "[pack-linux-docker] Artifacts should be under apps/desktop/release/linux/"
