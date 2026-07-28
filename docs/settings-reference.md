# Settings reference

Settings are edited in the **Settings** tab and persisted with `electron-store` (`name: 'settings'`), merged with defaults from `@transcriber/shared`.

On Windows the file is typically:

```text
%APPDATA%\Transcriber\settings.json
```

## Transcription

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `engine` | `'local' \| 'cloud'` | `'local'` | STT backend. Cannot change while a session is running. |
| `language` | string | `'en'` | UI options: `en`, `fr`, `es`, `de`, `auto` (auto mainly for local). |
| `localModel` | `'tiny' \| 'base' \| 'small' \| 'medium'` | `'base'` | faster-whisper size for Local engine. |
| `maxSpeakers` | `number \| 'auto'` | `'auto'` | Hint for local speaker banding / Deepgram usage context. UI: auto, 2–5. |
| `deepgramApiKey` | string | `''` | Required for Cloud engine. |
| `huggingfaceToken` | string | `''` | Optional `HF_TOKEN` for model downloads / gated Hub access. |

### Local model install

Selecting a model that is not yet available triggers an in-app download into:

```text
{userData}/hf-cache/hub/models--Systran--faster-whisper-<size>/
```

Bundled installer cache (read-only under Program Files) may already contain **`base`**. Progress is shown next to the model dropdown (`model:progress` IPC).

## Capture & window

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `micDeviceId` | string | `'default'` | Selected mic device id from the Session tab. |
| `systemAudioEnabled` | boolean | `true` | Request Chromium display-media loopback for system audio. |
| `alwaysOnTop` | boolean | `false` | Keep the main window above others. |

## Recording

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `recordSessionAudio` | boolean | `true` | Write mixed PCM to WAV during **live** sessions. |
| `recordingFolder` | string | `''` | Output directory. Empty = system Downloads (`app.getPath('downloads')`). |

WAV format: 16-bit PCM, mono, 16 kHz (identical mix sent to the STT engine).

Filename pattern (sanitized):

```text
Meeting <local-datetime>-<ISO-timestamp>.wav
```

## AI analysis

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `aiApiKey` | string | `''` | Bearer token for Chat Completions. |
| `aiBaseUrl` | string | `'https://api.openai.com/v1'` | API root (no trailing slash required; code normalizes). |
| `aiModel` | string | `'gpt-4o-mini'` | Model id. |
| `aiAutoAnalyze` | boolean | `true` | Debounced refresh as the transcript grows. |

Endpoint used: `{aiBaseUrl}/chat/completions` (OpenAI-compatible).

## Related on-disk data (not settings keys)

| Path under `{userData}` | Purpose |
|-------------------------|---------|
| `sessions/<id>.json` | Saved transcripts |
| `hf-cache/` | Downloaded Whisper models |
| `stt-venv/` | Fallback Python venv if no bundled runtime (dev / recovery) |
