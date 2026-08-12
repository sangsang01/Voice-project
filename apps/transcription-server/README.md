# Transcription server

Native GPU Whisper service with WebSocket streaming, fixed decoder pool, and
checksum-verified model provisioning.

## Models

```bash
npm run fetch-models --workspace @voice/transcription-server -- --model small
# or
npm run fetch-models --workspace @voice/transcription-server -- --model medium
```

Weights land in `models/` (gitignored). The fetcher always pulls Silero VAD
alongside exactly one multilingual Whisper tier (`ggml-small.bin` or
`ggml-medium.bin`). English-only `.en` names are rejected.

Pinned SHA-256 digests live in `test/fixtures/manifest.json`.

## CUDA image

```bash
npm run build:cuda-image --workspace @voice/transcription-server
```

Mount provisioned models and set `VOICE_MODEL_PATH`, `VOICE_VAD_MODEL_PATH`,
`VOICE_ALLOWED_ORIGINS`, and `VOICE_AUTH_TOKEN`. `/health/ready` returns 200
only after every decoder handle in the pool is warm.

## Benchmark gates

```bash
npm run benchmark --workspace @voice/transcription-server -- --model small
```

Hard gates (P95): first partial ≤1500 ms, refresh ≤1000 ms, final-after-silence
≤1500 ms, real-time factor <0.5 at four concurrent sessions. Quantized vs
unquantized accuracy is compared with `--compare baseline.json candidate.json`
and rejects aggregate WER/CER regressions above one absolute point (or any
language above two points).

## Model selection (GPU)

Reference GPU comparison (CUDA image, four-session fixture, `small` then
`medium`) was **not run on this host**: Docker daemon was unavailable
(`dockerDesktopLinuxEngine` pipe missing) even though an NVIDIA GPU was present.
No benchmark-results were fabricated. Until the comparison is executed on the
reference GPU, **no production model tier is accepted** from this worktree.
