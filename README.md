# Transcriber

Standalone desktop app for **live meeting transcription** with speaker labels. Capture your microphone and system audio (Discord, Meet, Zoom, in-person, etc.) — no bots or browser extensions.

| | |
|---|---|
| **Platforms** | Windows 10/11 (x64) primary; Linux packages optional |
| **Engines** | Local (faster-whisper) or Cloud (Deepgram) |
| **Install** | Single installer with bundled Python + Whisper `base` |

## Documentation

| Guide | Contents |
|-------|----------|
| [User guide](docs/user-guide.md) | Install, live sessions, recording, history, troubleshooting |
| [Settings reference](docs/settings-reference.md) | Every setting and default |
| [Architecture](docs/architecture.md) | Electron layout, audio pipeline, STT, IPC |
| [Development](docs/development.md) | Dev setup, packaging, scripts, paths |

## Quick start (end user)

1. Install `apps/desktop/release/windows/Transcriber Setup 0.1.0.exe` (or build with `npm run pack:win`).
2. Open **Settings** → pick **Local** or **Cloud** (Deepgram API key for cloud).
3. On **Session**, choose mic, enable system audio if needed → **Start**.
4. Allow microphone; when prompted, share a screen and enable **Share system audio**.
5. **Stop** saves the transcript (History) and, by default, a WAV of the mixed audio (Downloads).

## Quick start (developer)

```bash
npm install
npm run build -w @transcriber/shared
npm run dev
```

Windows installer:

```bash
npm run pack:win
```

## Features

- Live transcript with speaker chips (rename in the sidebar)
- Mic + system loopback mix (same stream for STT and optional WAV recording)
- Local Whisper models: `tiny` / `base` / `small` / `medium` (base preinstalled; others download in Settings)
- Cloud Deepgram with diarization
- Session history + TXT / Markdown / JSON export
- File transcription (load a recording)
- Optional AI analysis panel (OpenAI-compatible API)
- Always-on-top window

## Project layout

```
apps/desktop          Electron + React UI
packages/shared       Shared TypeScript types & defaults
services/stt-local    Python faster-whisper sidecar
scripts/              Python bundling & Linux pack helpers
docs/                 Full documentation
```

## License / notes

API keys (Deepgram, OpenAI-compatible, optional Hugging Face) are stored locally via `electron-store`. See [docs/user-guide.md](docs/user-guide.md) for audio caveats and [docs/development.md](docs/development.md) for packaging details.
