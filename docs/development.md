# Development

## Prerequisites

| Tool | Version / notes |
|------|-----------------|
| Node.js | ≥ 20 |
| npm | Workspaces (root `package.json`) |
| Python | 3.10+ for local STT in **dev** without a bundled runtime |
| Windows 10/11 x64 | Primary desktop target |
| Linux | Try from source — see [linux.md](linux.md) (`scripts/run-linux-dev.sh`); no AppImage for testers |
| Docker (optional) | Linux packages from Windows via `pack:linux:docker` (maintainers) |

## Clone & install

```bash
cd c:\Devop\transcriber   # or your clone path
npm install
npm run build -w @transcriber/shared
```

**Linux friends / contributors:** use [linux.md](linux.md) instead of packaging:

```bash
./scripts/run-linux-dev.sh
./scripts/run-linux-dev.sh --with-local   # Local Whisper venv
```

### Optional: local STT venv (dev)

If you are not using `apps/desktop/resources/python-runtime` yet:

```bash
cd services/stt-local
python -m venv .venv
.\.venv\Scripts\activate          # Windows
# source .venv/bin/activate       # Linux / macOS
pip install -r requirements.txt
cd ../..
```

Requirements: `faster-whisper`, `numpy` (`services/stt-local/requirements.txt`).

## Run in development

```bash
npm run dev
```

Runs Vite (renderer ~`http://localhost:5173`) and Electron via `vite-plugin-electron`. Main/preload rebuild on change.

On Linux, `./scripts/run-linux-dev.sh` wraps install + this command.

Useful checks:

- First **Start** with system audio: share screen + **Share system audio**.
- Settings → Local model install bar for non-base models.
- Stop a live session → recording notice + History entry.

## Build (compile only)

```bash
npm run build
```

Builds `@transcriber/shared` then `@transcriber/desktop` (`dist/` + `dist-electron/`).

## Bundle Python runtime

Portable Python + deps + Whisper **base** → `apps/desktop/resources/python-runtime`.

```bash
# Windows (must run on Windows)
npm run bundle:python -w @transcriber/desktop
# or force rebuild
node scripts/bundle-python-runtime.mjs --force

# Linux runtime (must run on Linux / Docker / WSL — not from native Windows Python path)
node scripts/bundle-python-runtime.mjs --platform=linux --force
```

Notes:

- Windows uses CPython **embeddable 3.12.10**.
- Linux prefers **python-build-standalone**, with venv fallback.
- Marker file: `resources/python-runtime/.bundle-ok`.
- Only **`base`** is pre-downloaded into `hf-cache`.

## Package Windows

```bash
npm run pack:win
```

Runs: bundle Python (if needed) → Vite/Electron build → electron-builder NSIS x64.

**Output**

```text
apps/desktop/release/windows/Transcriber Setup 0.1.0.exe
apps/desktop/release/windows/win-unpacked/   # unpacked app for debugging
```

Installer includes `stt-local` + `python-runtime` as `extraResources`.

## Package Linux

**Testers / friends:** do not use these pack scripts — run from source with [linux.md](linux.md) (`./scripts/run-linux-dev.sh`). No AppImage.

Maintainers only: Linux targets need a Linux environment (native, WSL, or Docker). Building the Linux Python runtime **from Windows** is blocked by `bundle-python-runtime.mjs`.

### Docker (recommended from Windows)

```bash
npm run pack:linux:docker
```

Requires Docker Desktop. Uses `electronuserland/builder:18` (override with `ELECTRON_BUILDER_IMAGE`). See `scripts/pack-linux-docker.ps1`.

### Native Linux

```bash
npm run pack:linux
```

### Outputs

```text
apps/desktop/release/linux/Transcriber-0.1.0-*.AppImage
apps/desktop/release/linux/Transcriber-0.1.0-amd64.deb
apps/desktop/release/linux/linux-unpacked/
```

**Performance tip:** Packaging ~800 MB of Python + model over `/mnt/c` in WSL is very slow. Prefer Docker or a native Linux disk, and AppImage-only if you do not need `.deb`.

Helper scripts (experimental / WSL): `scripts/pack-linux-wsl.sh`, `scripts/pack-linux-fast-wsl.sh`.

## Monorepo scripts (root)

| Script | Action |
|--------|--------|
| `npm run dev` | Desktop Vite + Electron |
| `npm run build` | Shared + desktop production build |
| `npm run start` | `electron .` against built desktop |
| `npm run pack` / `pack:win` | Windows installer |
| `npm run pack:linux` | Linux AppImage + deb (on Linux) |
| `npm run pack:linux:docker` | Linux via Docker from Windows |

## Important paths

| Path | Purpose |
|------|---------|
| `apps/desktop/src/` | React UI |
| `apps/desktop/electron/` | Main, preload, engines, stores |
| `apps/desktop/resources/python-runtime/` | Bundled Python (gitignored / generated) |
| `services/stt-local/server.py` | Sidecar protocol |
| `services/stt-local/download_model.py` | Model download with progress JSON |
| `packages/shared/src/index.ts` | Types & defaults |
| `apps/desktop/release/windows/` | Windows artifacts |
| `apps/desktop/release/linux/` | Linux artifacts |

### User data at runtime

| Path | Contents |
|------|----------|
| `{userData}/settings.json` | electron-store settings |
| `{userData}/sessions/` | History JSON |
| `{userData}/hf-cache/` | Downloaded models |
| `{userData}/stt-venv/` | Fallback venv |

Windows `{userData}` ≈ `%APPDATA%\Transcriber`.

## Desktop stack

- Electron **34**
- React **19** + Vite **6**
- `electron-store`, `ws`
- electron-builder **25** (NSIS / AppImage / deb)

## Testing checklist (manual)

- [ ] Local `base` live session (mic only)
- [ ] System audio loopback + remote speaker lines
- [ ] Download `small` from Settings; progress reaches Installed
- [ ] Cloud with Deepgram key
- [ ] Stop → WAV in Downloads + History entry
- [ ] Export TXT/MD/JSON
- [ ] File transcription
- [ ] AI analysis with key + Refresh
- [ ] Always on top

## Contributing notes

- Rebuild shared after changing `packages/shared`: `npm run build -w @transcriber/shared`.
- Prefer AppData for any writable model/cache paths in packaged builds.
- Do not commit secrets; settings files are local-only.
