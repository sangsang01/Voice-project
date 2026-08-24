# @voice/transcription-server

Loopback WebSocket gateway for **Live (this PC)** captions. It binds only to
loopback (`VOICE_HOST` default `127.0.0.1`, `VOICE_PORT` default `8787`),
keeps one warm native Whisper handle, and does not persist transcripts.
English-only `.en` model paths are rejected.

Subprotocol: `voice-transcription.v1`.

## Operator sequence (Windows)

From the repository root, in PowerShell. Quote paths if the checkout contains
spaces (`Tài liệu`).

```powershell
npm install
npm run build:native --workspace @voice/native-whisper-addon
npm run fetch-models --workspace @voice/transcription-server -- --model small
$env:VOICE_MODEL_PATH = Join-Path (Get-Location) "apps\transcription-server\models\ggml-small.bin"
$env:VOICE_VAD_MODEL_PATH = Join-Path (Get-Location) "apps\transcription-server\models\ggml-silero-v6.2.0.bin"
npm run dev:transcribe
```

`dev:transcribe` is the warm load. Wait until stderr prints
`listening on ws://127.0.0.1:8787` before starting the web app. Then in a
second terminal:

```powershell
npm run dev:web
```

Open `http://127.0.0.1:5173` (Cursor Simple Browser, Chrome, or Edge) and
press **Start**.

Root `npm install` / `npm run fetch-models` still fetch the **browser** WASM
`tiny` weights into `apps/web/public/models/`. Server models are a separate
fetch into `apps/transcription-server/models/`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `VOICE_HOST` | `127.0.0.1` | Bind host. Non-loopback values are refused. |
| `VOICE_PORT` | `8787` | Bind port. |
| `VOICE_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated browser Origins allowed at upgrade. |
| `VOICE_ORIGIN` | `http://localhost:5173` | Origin the **benchmark client** sends. |
| `VOICE_MODEL_PATH` | (required unless fake) | Multilingual Whisper weights. `.en` is rejected. |
| `VOICE_VAD_MODEL_PATH` | (required unless fake) | Silero VAD v6.2.0 weights. |
| `VOICE_THREADS` | `8` | Native decode threads. 8 was fastest on the 16-thread reference CPU; 14 was slower. |
| `VOICE_USE_GPU` | `0` | `0`/`1`. Use `1` only after a CUDA/Vulkan native compile. |
| `VOICE_FAKE_RUNTIME` | unset | `1` skips the native addon (CI/demo). |
| `VOICE_MAX_SESSIONS` | `1` | Concurrent listen sessions. |

There is no transcript database and no upload path. Caption text stays in the
browser UI for the current session.

A native decode timeout closes the handle (abort callback, join the current
ggml graph) and reloads weights once. That is recovery only.

## Fake runtime

```powershell
$env:VOICE_FAKE_RUNTIME = "1"
npm run dev:transcribe
```

CI and demos can exercise the gateway without compiling the addon or
downloading `small`/`base` weights.

## Benchmark

`npm run benchmark --workspace @voice/transcription-server` talks to an
already-running server. `--model` only **labels** the JSON. Changing the
actual model means: fetch the new weights, set `VOICE_MODEL_PATH` /
`VOICE_VAD_MODEL_PATH`, **restart the server**, then run the benchmark.

Gates:

- `firstPartialP95Ms` ≤ 1500
- `refreshP95Ms` ≤ 1000
- `finalAfterSilenceP95Ms` ≤ 1500

If CPU `small` fails the gates, rerun with `--model base` after switching the
server to `ggml-base.bin`. Do not change the code default from `small`.
