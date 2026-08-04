# Local multilingual transcription

This browser application transcribes live microphone audio with a local Whisper model by default. Select one to four candidates from Vietnamese (`vi-VN`), English (`en-US`), Spanish (`es-ES`), and Chinese (`zh-CN`); the application keeps the spoken text rather than translating it.

## Prerequisites and local setup

- Node.js 20 or newer and npm.
- A current desktop Chromium browser (Chrome or Edge recommended) with microphone access.
- Sufficient browser storage for the first local model download. WebGPU is preferred; WebAssembly is the fallback.

Install dependencies from the repository root, then start the web application:

```sh
npm install
npm run dev --workspace @voice/web
```

Open the local Vite URL, select at least one language, and choose **Start**. The initial local session downloads the quantized model into browser-managed storage. Keep the page open until that download completes. Later sessions reuse the cached assets and can run offline; clearing site storage, changing browser profiles, or changing the model version requires a new download.

## Privacy and cloud consent

Local transcription is the default. Audio conversion and inference run in the browser; the application does not intentionally upload microphone audio or store transcript history on a server.

**Use cloud transcription** opens an explicit confirmation dialog. Confirming is required before audio can leave the device, and a cloud provider may charge for that usage. Do not enable the cloud path without configuring its server-side credentials and access controls. Declining or closing the dialog leaves the session local.

## Browser support and limitations

The supported target is a recent desktop Chromium browser with `getUserMedia`, AudioWorklet, Web Workers, and browser storage. WebGPU generally improves latency; when it cannot initialize, the local engine retries with WebAssembly. Browsers without AudioWorklet or microphone permission cannot start a session.

Whisper produces window-level provisional and final segments, not guaranteed word-level language identification. Each segment is labeled only from the selected candidates, or `und` when confidence is insufficient. Mixed-language utterances, background noise, overlapping speakers, accents, and lower-end devices can increase latency or make labels uncertain. The model is a local convenience feature, not a safety-, medical-, legal-, or accessibility-critical transcription guarantee.

## Tests and browser verification

Run the workspace checks from the repository root:

```sh
npm test
npm run typecheck
npm run lint
npm run test:e2e --workspace @voice/web
```

The Playwright suite replaces microphone and worker APIs with deterministic fakes. It covers Start/Stop, rapid Clear & Restart, permission denial, worker crashes, reload with a simulated cached model, and a WebGPU-disabled retry to WASM. It intentionally does not require model download or assert speech-recognition accuracy.

## Benchmark

```sh
npm run benchmark --workspace @voice/web
```

The benchmark prints a `TRANSCRIPTION_BENCHMARK` JSON record with first provisional latency, final latency, realtime factor, peak queued audio, and expected/detected segment labels. It is non-blocking for quality: it reports timing and labeling instead of failing for accuracy. It fails only when the exercised pipeline crashes or no final text is produced.

`apps/web/tests/fixtures/four-language.wav` is a generated one-second silence WAV, licensed in its adjacent `LICENSE.md`. It is a legal transport fixture rather than a multilingual accuracy sample, so benchmark labels are truthfully `und` and accuracy is intentionally not scored. Substitute a separately licensed recording and record its provenance before making performance or language-accuracy claims.
