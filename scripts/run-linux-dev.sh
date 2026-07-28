#!/usr/bin/env bash
# Run Transcriber from source on Linux (dev). No AppImage / packaging.
#
# Usage:
#   ./scripts/run-linux-dev.sh              # install deps if needed, then npm run dev
#   ./scripts/run-linux-dev.sh --with-local # also create services/stt-local/.venv
#   ./scripts/run-linux-dev.sh --setup-only # deps (+ optional venv), do not start the app
#   ./scripts/run-linux-dev.sh --skip-install
#
set -euo pipefail

WITH_LOCAL=0
SETUP_ONLY=0
SKIP_INSTALL=0

for arg in "$@"; do
  case "$arg" in
    --with-local) WITH_LOCAL=1 ;;
    --setup-only) SETUP_ONLY=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Try: $0 --help" >&2
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script is for Linux. On Windows use: npm run dev" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { echo "[linux-dev] $*"; }
die() { echo "[linux-dev] error: $*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' not found. $2"
}

need_cmd node "Install Node.js 20+ (https://nodejs.org or your distro)."
need_cmd npm "Install npm (usually comes with Node.js)."

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if (( NODE_MAJOR < 20 )); then
  die "Node.js >= 20 required (found $(node -v))."
fi

if [[ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
  log "warning: no DISPLAY/WAYLAND_DISPLAY — Electron needs a graphical session."
fi

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  if [[ ! -d node_modules ]]; then
    log "npm install…"
    npm install
  else
    log "node_modules present — running npm install to sync workspaces…"
    npm install
  fi
  log "building @transcriber/shared…"
  npm run build -w @transcriber/shared
else
  log "skipping npm install / shared build (--skip-install)"
fi

if [[ "$WITH_LOCAL" -eq 1 ]]; then
  need_cmd python3 "Install Python 3.10+ for Local Whisper (or use Cloud in Settings)."
  VENV="$ROOT/services/stt-local/.venv"
  REQ="$ROOT/services/stt-local/requirements.txt"
  if [[ ! -x "$VENV/bin/python" ]]; then
    log "creating Local STT venv at services/stt-local/.venv…"
    python3 -m venv "$VENV"
  fi
  log "ensuring faster-whisper deps…"
  "$VENV/bin/python" -m pip install --upgrade pip
  "$VENV/bin/python" -m pip install -r "$REQ"
  "$VENV/bin/python" -c "import faster_whisper, numpy"
  log "Local STT venv ready"
else
  log "tip: for Local Whisper later, re-run with --with-local (or use Cloud + Deepgram key)."
fi

if [[ "$SETUP_ONLY" -eq 1 ]]; then
  log "setup done. Start with: npm run dev   (or re-run this script without --setup-only)"
  exit 0
fi

log "starting Electron + Vite (npm run dev)…"
log "system audio: uses Pulse/PipeWire monitor sources when available (Discord/Meet playback)."
exec npm run dev
