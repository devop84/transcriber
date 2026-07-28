# Transcriber (Linux)

Electron shell for Linux with PipeWire / PulseAudio **monitor** system-audio capture.

- Package: `@transcriber/desktop-linux`
- Reuses the React UI from `apps/desktop/src` (no duplicated `App.tsx`)
- Shared session / STT / settings logic via `@transcriber/core` (`JsonFileSettingsStore`)
- Dev server on port **5174** (Windows desktop uses 5173)
- **No AppImage** — run from source; Flatpak may come later

## Run

From the monorepo root:

```bash
./scripts/run-linux-dev.sh
# or
npm run dev:linux
```

Local Whisper venv:

```bash
./scripts/run-linux-dev.sh --with-local
```

See [docs/linux.md](../../docs/linux.md) for prerequisites, system audio notes, and troubleshooting.
