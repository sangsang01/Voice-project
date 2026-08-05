# @voice/api

Optional Node WebSocket gateway that fronts Google Cloud Speech-to-Text V1
streaming recognition for the multilingual realtime transcription app. This
service is opt-in: the app's default engine is local, in-browser Whisper.
Nothing here stores audio or transcript text, and Google credentials never
leave the server process.

**This gateway performs no user authentication of its own.** Do not enable
it on a public deployment until you add authentication in front of it (a
reverse proxy, an auth-aware load balancer, etc.). It is intended for local
development or a trusted, already-authenticated deployment.

## Application Default Credentials

The server never accepts credential material from the WebSocket client --
only Application Default Credentials (ADC) resolved server-side.

**Local development:**

```bash
gcloud auth application-default login
```

This writes a local ADC file that the `@google-cloud/speech` client
discovers automatically. Do not commit that file, and do not copy its
contents into `.env` or any request payload.

**Deployed environments:** use workload identity (GKE, Cloud Run, GCE) or a
dedicated service account key mounted as a file and referenced via
`GOOGLE_APPLICATION_CREDENTIALS`. Never bake a service-account JSON key into
a container image, commit it to source control, or pass it to the browser.

`apps/api/src/index.ts` is the only file in this app that constructs the
production Google client
(`createProductionSpeechClientFactory` from `@voice/google-transcription-engine/server`);
every other file is testable without any Google credentials at all.

## Running

`@voice/google-transcription-engine` is consumed as TypeScript source (its
`package.json` `exports` point straight at `./src/server.ts` /
`./src/browser.ts`); `@voice/transcription-contracts` is consumed as a
prebuilt `dist` (built by `npm run build` at the repository root, which the
root `test`/`typecheck` scripts already run first, and whose output is also
committed so a fresh clone works without a manual build step). Either way,
use the `start` script, which runs this app's own source directly through
`tsx`:

```bash
cp .env.example .env   # then edit ALLOWED_ORIGINS for your setup
npm run start --workspace @voice/api
```

If you edit `packages/transcription-contracts/src/**`, rebuild it before
starting the server: `npm run build --workspace @voice/transcription-contracts`.

`npm run build --workspace @voice/api` still exists as a standalone
`tsc` type-emit check (`tsconfig.build.json`) for consumers who want to
verify compiled output shape; it does not by itself produce a runnable
entrypoint given the unbuilt workspace dependencies.

## WebSocket protocol

The client opens one WebSocket per transcription session and speaks a
small JSON + binary protocol. See `src/websocket/protocol.ts` for the
authoritative validation.

**First message (required, JSON):**

```json
{
  "type": "session.start",
  "request": {
    "sessionId": "session-1",
    "candidateLanguages": ["vi-VN", "en-US", "es-ES", "zh-CN"],
    "mode": "transcribe",
    "audio": { "encoding": "pcm_s16le", "sampleRateHz": 16000, "channels": 1, "frameDurationMs": 20 }
  }
}
```

**After acceptance:**

- Every binary message must be exactly one **640-byte** PCM frame (320
  samples * 16-bit mono PCM at 16 kHz / 20 ms). Any other size closes the
  connection.
- JSON control messages: `{"type":"session.stop"}`, `{"type":"session.cancel"}`,
  `{"type":"session.ping"}`.

**Close codes:**

| Code | Meaning |
| ---- | ------- |
| 1000 | Normal closure (stop, cancel, disconnect, idle timeout, hard timeout) |
| 1008 | Policy violation -- malformed/out-of-order/invalid protocol message |
| 1009 | Message too big -- an oversized binary frame |
| 1011 | Internal error -- fatal provider error or server shutdown |
| 1013 | Try again later -- server at `MAX_CONCURRENT_SESSIONS` |

## Limits (see `src/config.ts`)

| Limit | Default | Safe ceiling |
| ----- | ------- | ------------ |
| Idle timeout (no valid activity) | 30,000 ms | 300,000 ms |
| Hard timeout (absolute session length) | 600,000 ms (10 min) | 1,800,000 ms |
| Frame size | 640 bytes (fixed, not configurable) | -- |
| Max buffered audio | 2,000 ms | 10,000 ms |
| Max concurrent sessions | 20 | 200 |

Overrides are read from the environment variables in `.env.example` and
validated at startup: a non-integer, non-positive, or above-ceiling value
refuses to start rather than silently running with a weaker limit.
`ALLOWED_ORIGINS` is a required, comma-separated, **exact-match** allowlist
outside test mode -- no wildcards or subdomain matching.

## Non-persistence

The server never writes audio or transcript text to disk or logs. Logs
contain only session IDs, durations, frame counts, and safe error codes.

## For the integration owner

- **Root workspace:** nothing to add at the repository root beyond the
  existing `npm run build --workspace @voice/api` / `test` / `typecheck`
  pattern already used by other workspaces.
- **This package's own dependencies** (already declared in
  `apps/api/package.json`, no root changes needed): `ws`, `@types/ws`,
  `@voice/transcription-contracts`, `@voice/google-transcription-engine`.
- **Browser-safe cloud engine import** (see
  `packages/google-transcription-engine/README.md` for the full contract):

  ```ts
  import { CloudEngineClient } from "@voice/google-transcription-engine/browser";

  const engine = new CloudEngineClient({
    cloudConsent: true, // only after the user explicitly opts in
    websocketUrl: "wss://your-api-host/", // this service's public URL
  });
  ```

- A production web build must never reference `@google-cloud/speech`. Verify
  with:

  ```bash
  npm run build --workspace @voice/web
  ```

  and inspect the output bundle for the string `@google-cloud/speech` --
  it must not appear. (This app, `@voice/api`, is the only place that
  dependency is meant to load.)
- This app does not edit `apps/web/**`, `packages/local-whisper-engine/**`,
  or `packages/transcription-contracts/**`.

## Verification

```bash
npm test --workspace @voice/api
npm test --workspace @voice/google-transcription-engine
npm run typecheck --workspace @voice/api
npm run typecheck --workspace @voice/google-transcription-engine
```

All four exit 0 without network access or Google credentials -- every test
uses an injected fake provider or a fake WebSocket.

## Known Google multilingual/code-switching limitations

- Google's V1 `streamingRecognize` reports one language per result; it
  cannot label a single utterance as mixed-language the way a human
  transcriber might mid-sentence code-switching.
- The API returns no confidence score dedicated to the *language* decision,
  only an overall recognition confidence for the transcript text. This
  gateway surfaces that transcript confidence as `language.confidence`
  because it is the only signal Google provides; treat it as a rough proxy,
  not a calibrated language-identification score.
- Google does not report an utterance's start time, only `resultEndTime`.
  `GoogleStream` reconstructs `startMs` from the previous result's end time,
  so segment boundaries are an approximation, not a value Google guarantees.
- `alternativeLanguageCodes` is capped at three by the Speech-to-Text V1 API
  itself, which is why the app limits language selection to four candidates
  total (one primary + three alternatives).
