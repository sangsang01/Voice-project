# Multilingual realtime transcription

This app transcribes live microphone audio in up to four languages at once,
chosen from Vietnamese (`vi-VN`), English (`en-US`), Spanish (`es-ES`), and
Chinese (`zh-CN`). It keeps the spoken text as-is rather than translating it.

It has two interchangeable transcription engines behind one shared contract:

- **Local (default).** A quantized Whisper model runs entirely in the
  browser (WebGPU, falling back to WebAssembly). Audio never leaves the
  device, and no server is required.
- **Cloud (opt-in).** Audio streams to a small self-hosted WebSocket
  gateway, which forwards it to Google Cloud Speech-to-Text. This requires
  running `apps/api` yourself and configuring Google credentials -- nothing
  is enabled by default, and switching to it always requires an explicit,
  on-screen consent click first.

## How the pieces fit together

```
apps/web        React app. Captures the mic, renders the transcript, and
                 chooses which engine to run against (local or cloud).
packages/local-whisper-engine
                 In-browser Whisper (WebGPU/WASM), runs in a Web Worker.
packages/google-transcription-engine
                 Two entrypoints: /browser (WebSocket client, no Google SDK)
                 and /server (wraps @google-cloud/speech; apps/api only).
apps/api         Optional Node WebSocket gateway. Only place that ever
                 talks to Google or holds Google credentials.
packages/transcription-contracts
                 The shared TranscriptionEngine/TranscriptionSession
                 TypeScript contract + validation both engines implement.
```

Both engines implement the exact same `TranscriptionEngine` contract
(`inspect` / `prepare` / `open` / `dispose`, with sessions exposing `push` /
`stop` / `cancel` / `subscribe`), so `apps/web` never has special-case logic
per engine -- it just constructs whichever one the user picked. See
`apps/web/src/features/transcription/engineFactory.ts`.

## Prerequisites

- Node.js 20+ and npm.
- A current desktop Chromium browser (Chrome or Edge) with microphone
  access, for the web app.
- Only if you want cloud transcription: a Google Cloud project with the
  Speech-to-Text API enabled, and the `gcloud` CLI for local credentials.

## Setup

Install everything from the repository root (this is an npm workspaces
monorepo -- one install covers `apps/*` and `packages/*`):

```bash
npm install
```

### Run local-only (no setup beyond the install above)

```bash
npm run dev --workspace @voice/web
```

Open the printed Vite URL, select one to four languages, and click
**Start**. The first session downloads the quantized model into
browser-managed storage -- keep the tab open until that finishes. Later
sessions reuse the cached model and can run offline. Clearing site storage,
switching browser profiles, or bumping the model version triggers a fresh
download.

### Add cloud transcription (optional)

1. **Authenticate the server to Google**, once, locally:

   ```bash
   gcloud auth application-default login
   ```

   This writes an Application Default Credentials (ADC) file that
   `@google-cloud/speech` picks up automatically. Never commit it, and
   never put it in `.env`. For a real deployment, use workload identity
   (GKE/Cloud Run/GCE) or a service account key referenced via
   `GOOGLE_APPLICATION_CREDENTIALS` -- never bake a key into an image or
   send it to the browser. Full detail in `apps/api/README.md`.

2. **Configure and start the gateway:**

   ```bash
   cp apps/api/.env.example apps/api/.env
   # edit apps/api/.env -- at minimum set ALLOWED_ORIGINS to your web app's
   # origin, e.g. http://localhost:5173 for `npm run dev`
   npm run start --workspace @voice/api
   ```

   It logs `{"event":"listening","port":8080}` (or whatever `PORT` you
   set) once ready. This process is the *only* place in the whole app that
   ever imports `@google-cloud/speech` or reads Google credentials --
   confirmed by the build check in [Verification](#verification) below.

3. **Point the web app at it**, if not using the default
   `ws://localhost:8080`:

   ```bash
   # apps/web/.env.local
   VITE_TRANSCRIPTION_WS_URL=ws://localhost:8080
   ```

   For a deployed gateway, use its public `wss://` URL instead.

4. Run the web app as above (`npm run dev --workspace @voice/web`). In the
   UI, click **Use cloud transcription**, read the consent dialog, and
   click **I consent to cloud transcription**. From then on **Start** opens
   a session against the gateway instead of the local model; **Switch to
   local transcription** reverts at any time, no re-consent needed to go
   back to local.

If the gateway is unreachable or rejects the connection, the UI shows a
visible error and stays in **Standby** -- it never silently falls back to
another engine or another destination for your audio.

## Privacy

Local is the default and requires no consent. Cloud transcription requires
an explicit, on-screen opt-in every time a browser session chooses it, and
sends audio to a server you (or your deployer) run and pay for. The
gateway (`apps/api`) never writes audio or transcript text to disk; its
only logging is session IDs, durations, frame counts, and generic error
codes -- see `apps/api/README.md#non-persistence`.

**The gateway ships with no authentication of its own.** It's meant for
local development or a deployment that already sits behind auth (reverse
proxy, authenticated load balancer, etc.). Do not expose it publicly as-is.

## Browser support and limitations

Target: a recent desktop Chromium browser with `getUserMedia`,
AudioWorklet, Web Workers, and browser storage. WebGPU improves local
latency; when it can't initialize, the local engine retries on WebAssembly.
Browsers without AudioWorklet or microphone permission can't start a
session at all.

Both engines produce window-level provisional/final segments, not
guaranteed word-level language ID, and label a segment `und` when
confidence is insufficient. Mixed-language utterances, background noise,
overlapping speakers, accents, and low-end devices can increase latency or
uncertainty. Neither engine is a safety-, medical-, legal-, or
accessibility-critical transcription guarantee.

Cloud-specific: Google's streaming API reports one language per result (no
true intra-sentence code-switching detection), reuses transcript confidence
as a rough stand-in for language confidence, and caps alternative languages
at three (hence the app's four-language limit). Full detail in
`packages/google-transcription-engine/README.md` and
`apps/api/README.md#known-google-multilingualcode-switching-limitations`.

## Verification

From the repository root:

```bash
npm test               # 188 tests across all workspaces
npm run typecheck
npm run lint
npm run test:e2e --workspace @voice/web   # Playwright, fake mic/worker seams
npm run build --workspace @voice/web
```

The last command also lets you confirm the browser bundle never references
the server-only Google SDK:

```bash
grep -r "google-cloud" apps/web/dist/   # must print nothing
```

`apps/api` and `packages/google-transcription-engine` test entirely against
injected fakes (`test/helpers/*`) -- no network access or Google
credentials needed to run the suite.

## Benchmark

```bash
npm run benchmark --workspace @voice/web
```

Prints a `TRANSCRIPTION_BENCHMARK` JSON record (first provisional latency,
final latency, realtime factor, peak queued audio, expected/detected
labels). It's non-blocking for accuracy -- it reports timing/labeling and
only fails if the pipeline crashes or produces no final text.
`apps/web/tests/fixtures/four-language.wav` is a generated one-second
*silence* WAV (see its `LICENSE.md`), so labels are truthfully `und` and
accuracy is intentionally not scored. The most recent recorded run:

```json
{"firstProvisionalLatencyMs":305,"finalLatencyMs":471,"realtimeFactor":1.88,"peakQueuedAudioMs":0,"expectedLabels":["und"],"detectedLabels":["und"]}
```

Substitute a separately licensed multilingual recording and record its
provenance before making real accuracy or language-ID claims.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "failed to open cloud transcription socket" | `apps/api` isn't running, `VITE_TRANSCRIPTION_WS_URL` doesn't match its address, or its `ALLOWED_ORIGINS` doesn't include the web app's origin. |
| Cloud session starts then immediately errors | Server-side Google auth isn't set up (`gcloud auth application-default login` not run, or `GOOGLE_APPLICATION_CREDENTIALS` unset/invalid in a deployed environment). |
| Local model never starts / stuck on "Preparing local model…" | Microphone permission denied, or the browser lacks WebGPU/WASM/AudioWorklet support -- check the browser console. |
| `npm run build --workspace @voice/api` fails after editing `packages/transcription-contracts` | Rebuild the contracts package first: `npm run build --workspace @voice/transcription-contracts` (its `dist` is committed and consumed directly). |
