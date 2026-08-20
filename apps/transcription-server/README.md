# Transcription server

Native GPU Whisper service with WebSocket streaming
(`voice-transcription.v1`), fixed decoder pool, and checksum-verified model
provisioning. This is the **Online real-time** backend:

```text
microphone -> WSS -> native GPU Whisper -> revisions -> browser
```

Ordinary unit tests inject a **fake runtime** and never load a native `.node`
binary or require a GPU.

## Protocol invariants

- Subprotocol: `voice-transcription.v1`.
- **One active session per socket.** A second `session.start` is rejected.
- Binary PCM messages are exactly **656 bytes** (see
  `@voice/streaming-protocol`).
- Servers emit `audio.ack` with `throughSequence` so clients can apply
  credit-based backpressure.
- Engine results are forwarded as `engine.event` using the shared
  `EngineEvent` contract (provisional revisions, then immutable finals).

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `VOICE_MODEL_PATH` | Yes | Multilingual Whisper weights (`*.en.bin` / `*.en-*` basenames rejected) |
| `VOICE_VAD_MODEL_PATH` | Yes | Silero VAD weights |
| `VOICE_PORT` | Yes | Listen port |
| `VOICE_MAX_SESSIONS` | Yes | Warm decoder pool size / admission capacity |
| `VOICE_ALLOWED_ORIGINS` | Yes | Comma-separated origin allowlist |
| `VOICE_AUTH_TOKEN` | Yes when auth on | Bearer token expected from clients |
| `VOICE_BIND_HOST` | No | Default `0.0.0.0`; use `127.0.0.1` for loopback |
| `VOICE_REQUIRE_AUTH` | No | Default on; `0` only allowed with loopback bind |
| `VOICE_THREADS` | No | Native threads (default `4`) |
| `VOICE_USE_GPU` | No | Default on; `0` forces CPU |
| `VOICE_METRICS_PATH` | No | JSONL metrics path (no audio/transcript content) |

Production: authenticated `wss:` plus origin allowlist. Development: plaintext
`ws:` and `VOICE_REQUIRE_AUTH=0` only when bound to loopback. Audio and
transcripts stay in memory for the session; persistence is disabled by default.

## Models

```bash
npm run fetch-models --workspace @voice/transcription-server -- --model small
# or
npm run fetch-models --workspace @voice/transcription-server -- --model medium
```

Weights land in `models/` (gitignored). The fetcher always pulls Silero VAD
alongside exactly one multilingual Whisper tier (`ggml-small.bin` or
`ggml-medium.bin`). English-only basenames matching `*.en.bin` / `*.en-*` are
rejected.

Pinned SHA-256 digests live in `test/fixtures/manifest.json`.

## Native addon and CUDA image

```bash
npm run build:native --workspace @voice/native-whisper-addon
npm run build:cuda-image --workspace @voice/transcription-server
```

Mount provisioned models and set at least `VOICE_MODEL_PATH`,
`VOICE_VAD_MODEL_PATH`, `VOICE_PORT`, `VOICE_MAX_SESSIONS`,
`VOICE_ALLOWED_ORIGINS`, and `VOICE_AUTH_TOKEN` (when auth is on).
`/health/ready` returns 200 only after every decoder handle in the pool is warm.

Each leased native handle serializes decode calls (one in flight per handle).
Final decodes take priority over coalesced provisional refreshes inside the
session scheduler.

## Benchmark gates

```bash
npm run benchmark --workspace @voice/transcription-server -- --model small
```

Hard gates (P95): first partial ≤1500 ms, refresh ≤1000 ms, final-after-silence
≤1500 ms, **decoder** real-time factor <0.5 at four concurrent sessions.
RTF is `sum(decodeDurationMs) / sum(audioDurationMs)` from server metrics
(`VOICE_METRICS_PATH` JSONL), not paced client wall clock. Point the benchmark
at the same metrics file with `--metrics <path>` (or the env var). Missing
latency/decode samples fail gates instead of passing as zero.

Quantized vs unquantized accuracy is compared with
`--compare baseline.json candidate.json` and rejects aggregate WER/CER
regressions above one absolute point (or any language above two points).
Accuracy selection requires real labeled fixtures; sine placeholders are not
sufficient to accept a production tier.

## Model selection (GPU)

Reference GPU comparison (CUDA image, four-session fixture, `small` then
`medium`) was **not run on this host**: Docker daemon was unavailable
(`dockerDesktopLinuxEngine` pipe missing) even though an NVIDIA GPU was present.
No benchmark-results were fabricated. Until the comparison is executed on the
reference GPU, **no production model tier is accepted** from this worktree.

## Run

```bash
npm run build --workspace @voice/transcription-server
npm run dev --workspace @voice/transcription-server
```

`dev` executes `node dist/main.js` after the TypeScript build. For real Whisper,
build the native addon and point `VOICE_*` paths at provisioned models first.
