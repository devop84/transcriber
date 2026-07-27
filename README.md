# Transcriber

Standalone Windows desktop app for **live meeting transcription** with speaker labels. Works with Discord, Google Meet, Zoom, in-person meetings, or anything else by capturing your microphone and system audio — no bots or browser extensions.

## Features

- Live transcript in a dedicated window
- Microphone + system audio (loopback) capture
- Engine switcher: **Cloud (Deepgram)** or **Local (faster-whisper)**
- Speaker differentiation and rename
- Session history with TXT / Markdown / JSON export
- Optional always-on-top mode

## Requirements

- Windows 10/11 (x64) recommended
- Node.js 20+
- Python 3.10+ (for local engine)
- Deepgram API key (for cloud engine)

## Setup

```bash
# from repo root
npm install
npm run build -w @transcriber/shared

# local STT sidecar (optional if you only use cloud)
cd services/stt-local
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
cd ../..
```

## Develop

```bash
npm run dev
```

This starts Vite + Electron. On first **Start** with system audio enabled, Chromium will ask you to share a screen/window — pick any screen and enable **Share system audio** so Discord/Meet audio is captured.

## Use

1. Open **Settings** and either paste a Deepgram API key (Cloud) or leave Local selected after installing the sidecar.
2. Choose microphone and enable system audio.
3. Click **Start**, allow mic permission, share screen with audio.
4. Speakers appear as Speaker 1, Speaker 2, … — click a name to rename.
5. **Stop** saves the session under History for export.

## Packaging

### Windows (this machine)

```bash
npm run pack:win
```

Produces `apps/desktop/release/windows/Transcriber Setup 0.1.0.exe` with a bundled portable Python + Whisper `base` model.

### Linux

Linux packages (**AppImage** + **.deb**) must be built on Linux (or via Docker). From Windows:

```bash
npm run pack:linux:docker
```

Requires Docker Desktop. Artifacts land in `apps/desktop/release/linux/`:
- `Transcriber-0.1.0-x64.AppImage` (or `…-x86_64.AppImage`)
- `Transcriber-0.1.0-amd64.deb`

Release layout:

```
apps/desktop/release/
  windows/   # .exe installer (+ win-unpacked)
  linux/     # .AppImage + .deb (+ linux-unpacked)
```

On a native Linux machine:

```bash
npm run pack:linux
```

Rebuild the Python runtime alone:

```bash
npm run bundle:python -w @transcriber/desktop
node scripts/bundle-python-runtime.mjs --force
node scripts/bundle-python-runtime.mjs --platform=linux --force
```

## Audio notes

- System audio uses Chromium loopback via display-media capture (Windows).
- Some headsets / exclusive-mode apps may need a virtual cable or stereo mix.
- Discord noise suppression and heavy VoIP compression can reduce speaker-separation quality.
- Local speaker labels use mic vs system energy plus turn heuristics; Cloud Deepgram diarization is usually stronger for multi-party calls.

## Project layout

```
apps/desktop          Electron + React UI
packages/shared       Shared TypeScript types
services/stt-local    Python faster-whisper sidecar
```
