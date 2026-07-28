# Architecture

## Overview

Transcriber is an Electron app with a React renderer. Audio is captured and mixed in the renderer, then streamed as 16 kHz mono PCM to the main process. The main process owns session state, optional WAV recording, and the selected transcription engine.

There are **two Electron shells**: `apps/desktop` (Windows) and `apps/desktop-linux` (Linux). Both reuse the React UI under `apps/desktop/src` and shared main-process logic in `packages/core` (plus `services/stt-local`).

```
┌─────────────────────────────────────────────────────────────┐
│ Renderer (React)                                            │
│  App.tsx · AudioCapture.ts                                  │
│  mic getUserMedia + system getDisplayMedia → mix → PCM      │
└────────────────────────────┬────────────────────────────────┘
                             │ contextBridge IPC
                             │ window.transcriber.*
┌────────────────────────────▼────────────────────────────────┐
│ Main (Electron)                                             │
│  main.ts · SessionController · SettingsStore · SessionStore │
│  SessionAudioRecorder · model-manager                       │
│       ├─ DeepgramEngine (WebSocket)                         │
│       └─ LocalWhisperEngine (child process)                 │
└────────────────────────────┬────────────────────────────────┘
                             │ spawn python + NDJSON
┌────────────────────────────▼────────────────────────────────┐
│ services/stt-local/server.py                                │
│  faster-whisper · SpeakerTracker (mic/system energy)        │
└─────────────────────────────────────────────────────────────┘
```

## Processes & packages

| Package / path | Role |
|----------------|------|
| `apps/desktop` | Windows Electron shell, React UI source, Windows packaging |
| `apps/desktop-linux` | Linux Electron shell; Vite aliases UI from `apps/desktop/src` |
| `packages/core` | Session controller, engines, stores, model manager, AI analyzer |
| `packages/shared` | Shared types, `DEFAULT_SETTINGS`, speaker helpers |
| `services/stt-local` | Python sidecar (`server.py`, `download_model.py`) |

### Electron layers

| Layer | Files | Notes |
|-------|-------|-------|
| Main | `electron/main.ts` (+ logic from `@transcriber/core`) | Privileged: spawn, FS, settings, dialogs |
| Preload | `electron/preload.ts` | `contextIsolation: true`; exposes `window.transcriber` |
| Renderer | `apps/desktop/src/App.tsx`, `AudioCapture.ts` | Shared UI; no Node integration |

## Audio pipeline

1. **Mic** — `navigator.mediaDevices.getUserMedia` (optional device id).
2. **System** — Pulse/PipeWire **monitor** source via `getUserMedia` when available (Linux); else `getDisplayMedia` with `electron-audio-loopback` (`audio: 'loopback'`).  
3. **Mix** — Web Audio: both sources into a gain node → `ScriptProcessorNode` (4096 samples).
4. **Resample** — Downsample to **16 kHz**, convert float → **int16 PCM**, ~250 ms frames.
5. **IPC** — `audio:pcm-chunk` → `SessionController.pushAudio`.
6. **Fan-out** — Same buffer → active engine `sendAudio` and, in live mode, `SessionAudioRecorder.append`.

Levels (RMS) are computed from separate analysers for mic vs system and sent as `audio:levels`.

## Transcription engines

### Local (`LocalWhisperEngine`)

- Resolves Python via `ensureLocalEnv()`:
  1. Bundled `resources/python-runtime`
  2. Dev `services/stt-local/.venv`
  3. Bootstrap `{userData}/stt-venv` + pip install
- Sets `HF_HOME` to **writable** `{userData}/hf-cache` (avoids Program Files write failures).
- Ensures model via `model-manager` (bundled or AppData snapshot).
- Spawns `python server.py` with env: `WHISPER_MODEL` (path or size), language, max speakers, HF token.
- Protocol: NDJSON on stdin/stdout (`audio` / `file` / `stop` → `ready` / `partial` / `final` / `error` / `file_done`).

**Local speakers** (`SpeakerTracker`): not neural diarization — uses mic vs system energy bands and turn heuristics. Live `S0` is labeled **You** in the UI.

### Cloud (`DeepgramEngine`)

- WebSocket to Deepgram listen API (Nova-2, interim results, `diarize=true`, linear16 @ 16 kHz).
- Speaker ids come from Deepgram word-level speaker tags.

## Model management

`electron/model-manager.ts`:

- Repos: `Systran/faster-whisper-{tiny,base,small,medium}`.
- Lookup order: user `hf-cache` → bundled `python-runtime/hf-cache`.
- Download: spawn bundled/dev Python with `download_model.py` + Hub `snapshot_download`; progress via stdout NDJSON and directory size estimates → `model:progress`.
- Packaged preload: `scripts/bundle-python-runtime.mjs` only pre-downloads **`base`**.

## Session lifecycle

`SessionController`:

1. **start** — create engine, optional WAV open, `engine.start(config)`.
2. **pushAudio** — levels + recorder + engine.
3. **stop** — engine stop, save session JSON if finals exist, finalize WAV, emit `session:recording-saved`.
4. **transcribeFile** — file mode; no live recorder; local uses sidecar `file` message, cloud uses prerecorded API path.

Sessions persist under `{userData}/sessions/<id>.json`.

## AI analysis

`electron/ai-analyzer.ts` builds a prompt from speakers + segments and calls Chat Completions. Renderer debounces auto-refresh when `aiAutoAnalyze` is on.

## IPC surface

### Invoke (renderer → main)

| Channel | Purpose |
|---------|---------|
| `settings:get` / `settings:set` | Load/patch settings |
| `settings:pick-recording-folder` / `settings:clear-recording-folder` | Recording path |
| `window:set-always-on-top` | Window flag |
| `audio:list-devices` | Loopback capability + platform |
| `audio:pcm-chunk` | Stream PCM + levels |
| `session:start` / `stop` / `transcribe-file` | Session control |
| `session:rename-speaker` / `list` / `get` / `delete` / `export` | Speakers & history |
| `ai:analyze` | One-shot analysis |
| `model:list` / `status` / `ensure` | Whisper install state |

### Events (main → renderer)

| Channel | Payload |
|---------|---------|
| `transcript:partial` / `transcript:final` | Segment |
| `transcript:speakers` | Speaker[] |
| `session:status` | Running state |
| `session:error` | Message |
| `session:recording-saved` | File path |
| `audio:levels` | `{ mic, system }` |
| `model:progress` | Download progress |

## Packaging resources

electron-builder `extraResources`:

- `services/stt-local` → `resources/stt-local` (excludes `.venv`)
- `apps/desktop/resources/python-runtime` → `resources/python-runtime`

At runtime: `process.resourcesPath` for packaged lookups.

## Design caveats (intentional / known)

- Capture uses `ScriptProcessorNode` (legacy; works; not AudioWorklet yet).
- Local diarization is heuristic, not pyannote/WhisperX (plan vs shipped simplification).
- API keys are not stored in OS keychain.
- Shared `IpcChannels` type may lag the real preload API — trust `preload.ts`.
