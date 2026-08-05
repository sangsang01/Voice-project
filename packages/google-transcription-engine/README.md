# @voice/google-transcription-engine

Optional Google Cloud Speech-to-Text V1 streaming fallback for the
multilingual realtime transcription app. Local, in-browser Whisper is the
default engine; this package exists only for the explicit, user-consented
cloud fallback.

The package has **two separate entrypoints and no root entrypoint**, so a
browser bundler can never accidentally pull in the Google SDK:

| Entrypoint | Imports `@google-cloud/speech`? | Use from |
| ---------- | -------------------------------- | -------- |
| `@voice/google-transcription-engine/server` | Yes (the only place in this package that does) | `apps/api` only |
| `@voice/google-transcription-engine/browser` | No | `apps/web` (or any browser bundle) |

## Browser usage: `CloudEngineClient`

```ts
import { CloudEngineClient } from "@voice/google-transcription-engine/browser";

const engine = new CloudEngineClient({
  cloudConsent: true, // set only after the user explicitly approves the cloud confirmation modal
  websocketUrl: "wss://your-api-host/", // the apps/api deployment's public WebSocket URL
});

await engine.prepare(sessionRequest); // no-op for the cloud engine, kept for contract parity
const session = await engine.open(sessionRequest);

session.subscribe((event) => {
  // event is a normalized EngineEvent from @voice/transcription-contracts
});

session.push(pcmFrame); // Int16Array PCM frames, forwarded as binary WebSocket messages; returns a PushResult
await session.stop(); // graceful drain
await session.cancel(); // immediate stop
```

`CloudEngineClient` implements the same `TranscriptionEngine` contract as
the local Whisper engine (`inspect` / `prepare` / `open` / `dispose`, with a
`TranscriptionSession` exposing `push` / `stop` / `cancel` / `subscribe`), so
it is a drop-in alternative behind the shared `createTranscriptionEngine`
factory -- see `docs/agent-tasks/integration.md`.

- **No consent, no socket.** If `cloudConsent` is not `true`, `open()`
  rejects immediately without ever constructing a `WebSocket` (there is no
  session yet to emit an event through, so the caller must surface the
  rejection itself, e.g. via `onLocalError`).
- **Backpressure.** If the browser socket's `bufferedAmount` grows past
  ~2 seconds of audio, `push()` drops the frame and emits a
  `type: "warning", code: "AUDIO_GAP"` event instead of buffering
  unboundedly.
- **Abnormal close mapping.** A WebSocket close with any code other than
  `1000` (normal closure) is surfaced as a fatal
  `type: "error", code: "UNAVAILABLE"` event.

## Server usage: `apps/api` only

`apps/api/src/index.ts` is the only place that imports
`@voice/google-transcription-engine/server` in this repository. See
`apps/api/README.md` for Application Default Credentials setup, the
WebSocket protocol, and session limits.

```ts
import { createProductionSpeechClientFactory, GoogleStream } from "@voice/google-transcription-engine/server";

const factory = createProductionSpeechClientFactory(); // Application Default Credentials only
const stream = new GoogleStream({ sessionId, candidateLanguages, factory, onEvent });
stream.write(frame); // returns false on backpressure from the underlying gRPC duplex
await stream.stop(); // drains and closes gracefully
stream.cancel(); // destroys the duplex immediately
```

## Google request configuration

- API: Speech-to-Text V1 `streamingRecognize`.
- Audio: `LINEAR16`, 16000 Hz, mono.
- `languageCode`: the first selected candidate language.
- `alternativeLanguageCodes`: the remaining selected languages, capped at
  three (Google's own V1 limit -- this is why the app caps language
  selection at four total).
- `interimResults: true`.

## Known Google multilingual/code-switching limitations

- Each streaming result carries exactly one `languageCode`; Google cannot
  label a single utterance as mixed-language for genuine intra-sentence
  code-switching.
- Google reports no distinct language-identification confidence -- only an
  overall transcript recognition confidence. This package surfaces that
  value as `segment.language.confidence` for lack of anything more precise;
  treat it as a rough proxy, not a calibrated per-language score.
- Google reports `resultEndTime` but never a result's start time.
  `GoogleStream` derives `startMs` from the previous result's end time, so
  segment boundaries are an approximation the app computes, not a value
  Google guarantees.
- A new `ordinal` (and therefore a new transcript segment ID) is assigned
  whenever the previous result went final; every non-final update to the
  same in-progress result bumps `revision` instead. This mirrors how
  Google's streaming API evolves a single result over time, but it is this
  package's own bookkeeping, not something the API hands back directly.

## Testing

All tests use an injected fake Speech client (`test/helpers/fakeGoogleStream.ts`)
or a fake `WebSocket` (`test/helpers/fakeWebSocket.ts`) -- no network access
or Google credentials required:

```bash
npm test --workspace @voice/google-transcription-engine
npm run typecheck --workspace @voice/google-transcription-engine
```
