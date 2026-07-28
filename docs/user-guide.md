# User guide

Transcriber is a standalone desktop window that listens to your **microphone** and optional **system audio**, shows a live transcript with speaker labels, and can save both the transcript and a WAV of what was heard.

## Install (Windows)

1. Run `Transcriber Setup 0.1.0.exe` (from `apps/desktop/release/windows/` after a pack, or a release build).
2. Launch **Transcriber** from the Start Menu or desktop shortcut.
3. No separate Python or Node install is required for the packaged app.

The installer bundles Electron, a portable Python runtime, the local STT sidecar, and the Whisper **`base`** model.

## First-time setup

Open the **Settings** tab.

### Transcription engine

| Engine | When to use | What you need |
|--------|-------------|----------------|
| **Local (Whisper)** | Offline / privacy | Nothing for `base`; larger models download on select |
| **Cloud (Deepgram)** | Better live multi-speaker diarization | Deepgram API key |

### Local Whisper model

- **`base`** — included with the app.
- **`tiny` / `small` / `medium`** — select in Settings; a progress bar shows download into your user folder (not Program Files).
- Approximate sizes: tiny ~75 MB, base ~145 MB, small ~460 MB, medium ~1.5 GB.

### Recording

- **Record live session audio** is on by default.
- Saves a **16 kHz mono WAV** of the same mic + system mix the model hears.
- Default folder: your **Downloads** directory. Use **Browse…** to change, **Reset** to return to Downloads.

### AI analysis (optional)

Paste an OpenAI-compatible API key (OpenAI, OpenRouter, Azure proxy, etc.) to enable the right-hand analysis panel (summary, key points, suggested replies, open questions).

## Live session

1. Go to **Session**.
2. Pick a **microphone** (or system default).
3. Optionally enable **Capture system audio (Discord / Meet)**.
4. Click **Start**.
5. Allow microphone access.
6. If system audio is on, choose a screen/window and enable **Share system audio** (required for Discord/Meet playback).
7. Speak / play meeting audio — lines appear at the bottom of the transcript.
8. Click a speaker name in the sidebar to rename (e.g. Speaker 2 → “Alex”).
9. Click **Stop**.

### What happens on Stop

- Transcript is saved under **History** (if there was any finalized text).
- If recording is enabled, a WAV is written and a green notice shows the path.

### Levels

**Mic level** and **System level** meters help verify capture. If system stays flat, re-share with system audio enabled.

## File transcription

Use **Load audio file** to transcribe an existing recording (wav, mp3, m4a, etc.) without live capture. Local or Cloud engine applies. Session audio recording does **not** duplicate file-mode sources.

## History

- Open past sessions, re-read transcripts, rename speakers if shown.
- Export **TXT**, **MD**, or **JSON**.
- Delete sessions you no longer need.

## Tips for better results

- Prefer **Cloud** for crowded calls with many remote speakers.
- Prefer **Local `small` or `medium`** for offline accuracy (heavier CPU/RAM).
- Disable Discord/VoIP noise suppression if local speaker separation looks wrong.
- Exclusive-mode audio apps or some USB headsets may need **Stereo Mix** or a virtual cable for system capture.

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| No system audio | On Start, share a **screen** and check **Share system audio** |
| Mic denied | Windows Settings → Privacy → Microphone → allow Transcriber |
| `Accès refusé` / model download failed under Program Files | Use an app build with in-app model install (downloads go to AppData). Re-select the model in Settings |
| Local model slow to start | First load downloads/unpacks weights; watch Settings progress for non-base models |
| Cloud won’t start | Add a Deepgram key in Settings; ensure network access |
| Empty recording | Confirm **Record live session audio** is on and you stopped after some capture |
| AI panel empty | Add AI API key; need enough transcript lines; try Refresh |

## Data on your machine (Windows)

Typical locations (product name may appear as Transcriber under AppData):

| Data | Location |
|------|----------|
| Settings | `%APPDATA%\Transcriber\settings.json` (electron-store) |
| Session history | `%APPDATA%\Transcriber\sessions\*.json` |
| Downloaded Whisper models | `%APPDATA%\Transcriber\hf-cache\` |
| Live recordings | Downloads (or your chosen folder) |

Uninstalling the app does not always remove AppData; delete that folder manually if you want a clean wipe.

## Privacy

- **Local** mode keeps audio and transcripts on your machine (except optional AI / Hugging Face downloads you trigger).
- **Cloud** mode streams audio to Deepgram.
- **AI analysis** sends transcript text to the configured Chat Completions endpoint.
- API keys are stored locally in plain settings storage (not OS keychain).
