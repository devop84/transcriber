# Linux (run from source)

Transcriber ships a **separate Linux Electron app** at `apps/desktop-linux` (`@transcriber/desktop-linux`). The Windows app remains at `apps/desktop`. On Linux the supported way to try it is **from source** — not AppImage.

For a full packaging / architecture overview see [development.md](development.md) and [architecture.md](architecture.md).

## What works today

| Feature | Linux (dev) |
|---------|-------------|
| UI, settings, history, export, AI panel | Yes (shared React UI from `apps/desktop/src`) |
| Microphone live sessions | Yes (grant permission when prompted) |
| **System audio** (Discord / Meet / Zoom) | **Yes** — PulseAudio / PipeWire **monitor** source, with Chromium loopback fallback |
| Local Whisper / Cloud Deepgram | Yes (Local needs Python venv or first-run bootstrap) |
| File transcription | Yes |

### System audio on Linux

With **Capture system audio** enabled, the app:

1. Looks for a PulseAudio / PipeWire **sink monitor** (e.g. “Monitor of …” / `*.monitor`) and captures it like a mic — no screen picker.  
2. If none are found, falls back to Electron **display-media loopback** (`electron-audio-loopback`).

Check the **System** level meter while playing meeting audio. If it stays flat:

- Confirm output is going to the default sink (speakers/headphones), not a disconnected device.  
- PipeWire: `pactl list short sources` should show a `*.monitor` source; volume not muted.  
- Try playing YouTube in the browser and watch the System meter.  
- On some Wayland setups the loopback fallback may still prompt for screen share — allow it and enable system audio if asked.

## Prerequisites

| Tool | Notes |
|------|--------|
| Node.js | **≥ 20** + npm |
| Graphical session | X11 or Wayland (`DISPLAY` / `WAYLAND_DISPLAY`) |
| Python 3.10+ | Optional; only for **Local** Whisper (`--with-local`) |
| Electron system libs | Most desktops already have them; if Electron fails to start, install your distro’s usual Electron/Chromium deps (e.g. GTK 3) |

No Docker, no AppImage, no `pack:linux` required for trying the app.

## Quick start (recommended)

From the repo root:

```bash
chmod +x scripts/run-linux-dev.sh   # once, if needed
./scripts/run-linux-dev.sh
```

That will:

1. Check Node ≥ 20 and a display session  
2. `npm install` if needed  
3. Build `@transcriber/shared` and `@transcriber/core`  
4. Start **`npm run dev:linux`** (Vite on port **5174** + Electron for `@transcriber/desktop-linux`)

### Local Whisper in one go

```bash
./scripts/run-linux-dev.sh --with-local
```

Creates `services/stt-local/.venv` and installs `faster-whisper` + `numpy`. First Local session may still download model weights (network + disk).

### Setup only (no window)

```bash
./scripts/run-linux-dev.sh --setup-only
./scripts/run-linux-dev.sh --setup-only --with-local
```

Then later: `npm run dev:linux` or `./scripts/run-linux-dev.sh --skip-install`.

## Manual steps (same as the script)

```bash
git clone <repo-url> transcriber
cd transcriber

npm install
npm run build -w @transcriber/shared
npm run build -w @transcriber/core
npm run dev:linux
```

Optional Local STT:

```bash
cd services/stt-local
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd ../..
```

## Trying the app

1. Open **Settings**.  
2. Easiest path: **Cloud** + a Deepgram API key (no Python).  
   Or **Local** if you used `--with-local`.  
3. **Session** → pick a mic → enable **Capture system audio** → **Start**.  
4. Speak / play Discord or Meet audio — **Mic** and **System** meters should move; transcript lines appear.  
5. **Stop** → check History / optional WAV under Downloads (or your recording folder).

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| `Node.js >= 20 required` | Upgrade Node (nvm, nodesource, or distro package) |
| Electron exits immediately / missing `.so` | Install GTK3 / common Electron runtime packages for your distro |
| No window / display errors | Run from a desktop session, not a headless SSH without X11/Wayland forwarding |
| Local engine fails | Re-run with `--with-local`, or switch to Cloud |
| Flat system level / no meeting audio | See [System audio on Linux](#system-audio-on-linux); verify `*.monitor` with `pactl list short sources` |
| Slow `npm install` | Normal first time; Electron downloads a binary |

## Data locations (Linux)

Electron `userData` for the Linux app is typically under:

`~/.config/Transcriber-Linux/`

| Data | Path |
|------|------|
| Settings | `~/.config/Transcriber-Linux/settings.json` (`JsonFileSettingsStore`) |
| Sessions | `~/.config/Transcriber-Linux/sessions/` |
| Downloaded models / HF cache | `~/.config/Transcriber-Linux/hf-cache/` |
| Fallback STT venv (if no project `.venv`) | `~/.config/Transcriber-Linux/stt-venv/` |

## What we are not shipping (yet)

- AppImage / “download this binary and run it”  
- Flathub / Flatpak (future Linux product channel)  

For packaging experiments on the Windows app shell (maintainers only), see [development.md](development.md) — those paths are optional and not how friends should try the Linux app.
