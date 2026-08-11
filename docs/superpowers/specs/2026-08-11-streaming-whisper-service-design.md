# Streaming Whisper Service Design

**Date:** 2026-08-11

**Status:** Proposed for user review
**Builds on:** `2026-08-08-whisper-cpp-vad-migration-design.md`

## Purpose

Make source-language transcription appear while a person is still speaking,
with an accurate final correction shortly after speech ends. The feature must
work from an ordinary web browser so the same service can later support iPhone
Safari and a thin Siri/App Intents companion.

The current browser-only engine cannot satisfy that goal. It runs whisper.cpp
as one-thread WebAssembly without GPU acceleration, waits for Silero VAD to
flush an utterance, and then emits one final segment. A real 2.088-second
utterance took roughly 42-47 seconds to decode in Chromium. The new design keeps
the tested browser capture, session lifecycle, event contract, reducer, and
local engine fallback, but moves the primary inference path to a warm native
whisper.cpp service with GPU support.

Translation and Siri integration are deferred. This design creates the
streaming boundary they can consume later.

## Goals

- Show a first provisional transcript within 1.5 seconds of speech beginning
  on the reference deployment.
- Refresh provisional text at least once per second while speech continues.
- Emit an accurate final transcript within 1.5 seconds after the configured
  500 ms trailing-silence boundary.
- Preserve multilingual Whisper; never use an `.en` model in production.
- Preserve the existing 16 kHz, mono, 20 ms PCM frame contract and
  revision-safe transcript reducer.
- Make the primary transcription path reachable from desktop and mobile web
  clients over a secure connection.
- Keep the completed browser-local engine as an explicit offline fallback.
- Keep audio ephemeral: no recording or transcript persistence in this phase.

## Non-goals

- Text translation, speech synthesis, diarization, or conversation memory.
- Siri/App Intents implementation or an iOS application in this phase.
- Training or fine-tuning Whisper.
- Automatic failover from remote to local in the middle of an utterance.
- Supporting arbitrary audio formats; the wire protocol accepts only the
  existing PCM format.
- Unlimited public multi-tenancy. The first deployment has explicit admission
  and per-session limits.

## Approaches considered

| Approach | Benefits | Costs | Decision |
| --- | --- | --- | --- |
| Native whisper.cpp service with a Node WebSocket gateway | Reuses the pinned runtime and contracts; supports native CPU/GPU acceleration | Requires a maintained N-API wrapper and GPU deployment | **Chosen** |
| `faster-whisper` Python service | Mature GPU runtime and comparatively quick server implementation | Introduces a second Whisper runtime and Python deployment | Benchmark fallback if native whisper.cpp misses latency targets |
| Further optimize browser WASM | No server cost and strongest privacy | Current path is about 20x slower than real time; mobile performance is unpredictable | Rejected as the primary everywhere-available path |

The upstream whisper.cpp `whisper-stream` example demonstrates rolling
inference every 500 ms, but it is a simple microphone example rather than a
network service. The production service adopts its rolling-window principle
while retaining this repository's Silero boundaries, event ordering,
cancellation, and backpressure rules.

## Architecture

```text
apps/web
  microphone.ts (unchanged 20 ms PCM frames)
       |
       v
packages/remote-whisper-engine
  RemoteWhisperEngine implements TranscriptionEngine
       |
       | WSS: JSON control/events + binary PCM frames
       v
apps/transcription-server (Node/TypeScript)
  authentication, validation, session limits, scheduling
       |
       v
packages/native-whisper-addon (C++ N-API)
  persistent whisper.cpp + Silero contexts, native CPU/GPU inference
       |
       v
EngineEvent -> existing SessionController -> existing sessionReducer -> UI
```

The browser does not know which GPU backend runs on the server. Deployment
chooses CUDA, Vulkan, Metal, or CPU when compiling whisper.cpp. The gateway
exposes one protocol and reports its model/runtime capabilities during the
handshake.

The initial production reference is one Linux `amd64` NVIDIA L4-class GPU with
24 GB VRAM, a CUDA whisper.cpp build, and four concurrent active sessions. A
different provider may substitute equivalent-or-better hardware, but it must
pass the same four-session latency and accuracy gates before serving traffic.

### Repository boundaries

- `packages/remote-whisper-engine/` owns the browser WebSocket adapter and no
  UI state.
- `packages/streaming-protocol/` owns wire schemas, binary-frame encoding, and
  runtime validation shared by client and server.
- `apps/transcription-server/` owns connections, authentication, session
  scheduling, admission control, and mapping native results to engine events.
- `packages/native-whisper-addon/` owns persistent native model/VAD contexts
  and asynchronous decode calls. It is based on the pinned upstream N-API
  example but maintained by this repository; upstream remains unpatched.
- `packages/local-whisper-engine/` remains intact as the offline fallback.
- `apps/web/` selects the remote engine by default through its existing
  `EngineFactory` seam. UI components do not open sockets directly.

## Wire protocol

The WebSocket subprotocol is `voice-transcription.v1`. Production uses `wss:`;
unencrypted `ws:` is accepted only on loopback in development.

### Client control messages

```ts
type ClientControl =
  | { type: "session.start"; protocol: 1; request: SessionRequest }
  | { type: "session.stop"; sessionId: string }
  | { type: "session.cancel"; sessionId: string };
```

PCM travels in binary messages to avoid JSON/base64 expansion. One WebSocket
owns at most one active session, so audio messages do not repeat the session ID.
Every message is exactly 656 bytes: byte 0 is protocol version `1`; byte 1 is
message type `1` (PCM); bytes 2-3 are zeroed reserved bytes; bytes 4-7 are an
unsigned little-endian frame sequence; bytes 8-15 are a little-endian Float64
`startMs`; and bytes 16-655 contain exactly 320 signed little-endian 16-bit
samples. The shared protocol package rejects malformed headers, incorrect
payload sizes, nonzero reserved bytes, non-monotonic sequences, and unsupported
versions.

### Server messages

```ts
type ServerMessage =
  | { type: "session.accepted"; sessionId: string; model: string }
  | { type: "audio.ack"; sessionId: string; throughSequence: number }
  | { type: "engine.event"; event: EngineEvent };
```

`EngineEvent` remains the application-level contract. No provider-specific
types leak into React or the reducer. Audio acknowledgements bound the client
queue and make network backpressure observable. Unknown or malformed messages
terminate only the affected session with a normalized fatal error.

## Streaming transcription flow

1. `prepare()` opens the socket, authenticates, and waits for server model
   readiness. The model is already warm in a healthy deployment.
2. `open()` sends `session.start`. The server validates candidate languages and
   reserves decoder capacity before returning `session.accepted`.
3. `push()` serializes each existing PCM frame and returns synchronously. It
   reports backpressure only when the bounded unacknowledged-frame queue is
   full or the socket cannot accept data.
4. The native runtime feeds samples continuously into stateful Silero VAD. VAD
   identifies speech start and the final utterance boundary, but does not block
   provisional decoding.
5. During speech, the scheduler requests a rolling decode every 750 ms. The
   default window contains up to the latest 8 seconds plus a 500 ms overlap and
   the last stable prompt. Only one decode per session runs at a time; ticks
   that arrive during decoding coalesce into one newest-window request.
6. Each provisional hypothesis upserts the current utterance segment with the
   same `id` and `ordinal`, incremented `revision`, and `isFinal: false`.
7. After 500 ms trailing silence, the server decodes the bounded complete
   utterance once more and upserts it with `isFinal: true`. The next speech
   boundary receives a new segment ID and ordinal.
8. `stop()` drains buffered speech, emits the final segment and `stopped`, then
   releases capacity. `cancel()` discards buffered audio immediately.

The first provisional result may use language `und` because detection from very
short audio is unstable. The final result performs acoustic language detection
and maps it to the request's candidate languages using the existing policy.

## Model and accuracy policy

The server model is deployment configuration rather than a browser manifest.
The initial benchmark compares multilingual `small` and `medium` on the target
GPU using the four-language fixture plus longer clean/noisy samples. The default
is the most accurate model that meets every latency objective at target
concurrency. `tiny.en`, `base.en`, and all other English-only variants are
prohibited.

Quantization is a benchmark decision. Against the same unquantized model tier,
it is accepted only when aggregate WER for alphabetic-language fixtures and CER
for Mandarin regress by no more than one absolute percentage point, with no
individual language regressing by more than two points. Provisional text may
change; final text is immutable under the existing reducer rule. This gives
immediate feedback without treating a low-context hypothesis as final output.

## Capacity and backpressure

- Each native model context handles one decode at a time.
- A server process owns a fixed decoder pool; deployment scales by adding
  replicas rather than issuing unbounded parallel calls into one context.
- Admission fails with `RESOURCE_EXHAUSTED` before microphone capture begins
  when no reservation is available.
- A session has limits for buffered audio, duration, idle time, message rate,
  and unacknowledged bytes.
- Rolling decode ticks coalesce; they never queue historical partial jobs.
- Final decodes take priority over provisional refreshes.
- Metrics include queue delay, decode duration, audio duration, and real-time
  factor without logging audio or transcript content.

The production capacity gate is real-time factor below `0.5` at target
concurrency. This leaves headroom for network jitter and final decoding.

## Security and privacy

- Production accepts authenticated `wss:` connections only.
- Browser tokens are short-lived and scoped to starting transcription sessions;
  long-lived service secrets never enter the web bundle.
- The gateway enforces an origin allowlist, schema validation, payload limits,
  rate limits, and per-account concurrency.
- Audio and transcripts remain in memory and are released when the session
  ends. Persistence is disabled by default.
- Logs contain opaque session IDs, timings, sizes, model version, error codes,
  and resource usage only.
- Development may use an unauthenticated mode bound to `127.0.0.1`; that mode
  refuses non-loopback binding.

## Failure handling

- Failure before `session.accepted`: `prepare()` or `open()` fails and the
  microphone never starts.
- Socket loss: emit one fatal `UNAVAILABLE`, stop capture, and preserve already
  final transcript segments. Do not silently replay ambiguous audio elsewhere.
- Server overload: reject admission with `RESOURCE_EXHAUSTED`; do not accept and
  then drop arbitrary speech.
- Decode timeout: cancel the job when supported, recycle the unhealthy decoder
  process/context, and emit `TIMEOUT`.
- Sequence gap: emit `AUDIO_GAP`; continue only when the gap is bounded.
- Invalid protocol/audio: terminate the session with `INVALID_AUDIO` or
  `UNSUPPORTED`.

The local engine remains user-selectable as an offline mode. Automatic
mid-session switching is excluded because it can duplicate or reorder text.

## Web and future iPhone/Siri path

The first client remains the responsive React web application. It connects to
the same service from desktop browsers and iPhone Safari while the page is in
the foreground. Mobile background capture is not promised.

The transcript visually marks `isFinal: false` segments as provisional and
replaces them in place as revisions arrive. Rapid partial revisions are not
announced individually through an ARIA live region; assistive technology gets
the listening status and newly finalized segments so it does not reread a
changing sentence every 750 ms. Engine labeling changes from the hard-coded
"Local transcription" string to explicit "Online real-time" and "Offline
local" modes.

A later thin iOS companion can expose an App Intent such as "Start live
transcript" to Siri and open the transcription experience. It reuses this
server protocol and event model rather than creating a second backend. Siri is
therefore an entry point, not the owner of inference or transcript state.

## Testing strategy

### Unit and contract tests

- Binary protocol round trips, malformed payloads, version rejection, and
  monotonic sequence validation.
- `RemoteWhisperEngine` passes the existing engine contract suite.
- Socket lifecycle covers prepare/open/stop/cancel, callback reentrancy, late
  events, disconnects, and disposal.
- Credit-based backpressure and acknowledgement ordering.
- Server state covers rolling-tick coalescing, VAD finalization, revisions,
  immutable finals, and final-decode priority.
- Native-wrapper lifecycle uses an injected fake runtime in ordinary CI.

### Integration and browser tests

- An in-process WebSocket server drives real binary frames and partial/final
  events through `SessionController` and the reducer.
- Playwright verifies provisional text appears before final text and that later
  revisions replace rather than duplicate it.
- Stop, cancel, restart, microphone denial, socket loss, overload, and
  backpressure retain their lifecycle guarantees.

### Native/GPU verification

- A native smoke test loads the multilingual model once and transcribes fixed
  PCM without temporary files.
- A deployment benchmark records first-partial latency, refresh interval,
  final-after-silence latency, decode time, real-time factor, GPU memory, and
  throughput at target concurrency.
- Accuracy is compared on clean and noisy English, Vietnamese, Spanish, and
  Mandarin fixtures. Model selection is not accepted from speed alone.

GPU benchmarks are deployment gates, not required for every developer's unit
test run. Deterministic fake-runtime coverage remains available without a GPU.

## Delivery sequence

1. Add and test the versioned streaming protocol package.
2. Add `RemoteWhisperEngine` against a fake WebSocket server and pass the shared
   contract suite.
3. Add the server session state machine with an injected fake native runtime.
4. Extract a persistent N-API runtime from the pinned upstream addon pattern;
   keep the upstream submodule unmodified.
5. Benchmark multilingual `small` and `medium`; select model and quantization
   from evidence.
6. Wire the web app to remote-by-default with explicit local fallback.
7. Run lifecycle, browser, security, latency, and multilingual accuracy checks.
8. Document development, model provisioning, GPU builds, authentication, and
   capacity limits.

## Acceptance criteria

- Existing local-engine, reducer, lifecycle, and microphone tests remain green.
- The remote engine passes the reusable `TranscriptionEngine` contract suite.
- A real browser displays a non-final segment before the final segment for a
  continuous utterance.
- On one NVIDIA L4-class 24 GB GPU with four simultaneous sessions: first
  provisional text p95 is at
  most 1.5 seconds after speech begins; refresh p95 is at most 1 second; final
  text p95 is at most 1.5 seconds after the 500 ms silence boundary; decoder
  real-time factor is below `0.5`.
- Any selected quantization stays within the one-point aggregate and two-point
  per-language WER/CER regression limits relative to its unquantized tier.
- Final segments never regress, duplicate, or reorder after revisions.
- Malformed messages, audio gaps, overload, disconnects, stop, cancel, and
  restart have bounded, deterministic behavior.
- The browser bundle contains no model weights, native binaries, or long-lived
  server credentials.
- Audio and transcript text are absent from server logs and are not stored.
- Desktop and iPhone Safari use the same HTTPS/WSS deployment while foregrounded.
- Documentation distinguishes remote real-time mode from slower browser-local
  offline fallback mode.

## Risks

1. **GPU cost and capacity.** Larger multilingual models consume significant
   memory. Mitigation: benchmark model/quantization combinations, reserve
   sessions before capture, and scale a bounded decoder pool horizontally.
2. **Partial text instability.** Whisper is not a native token-streaming ASR
   model. Mitigation: rolling context, stable segment IDs/revisions, and a final
   full-utterance correction.
3. **Native addon portability.** N-API and GPU builds add deployment complexity.
   Mitigation: build in a pinned container, keep fake-runtime CI independent,
   and retain `faster-whisper` as a measured fallback.
4. **Mobile browser lifecycle.** iOS may suspend web work when the page
   backgrounds. Mitigation: promise foreground use only and defer background
   behavior to the later companion.
5. **Network privacy and reliability.** Audio leaves the device in remote mode.
   Mitigation: TLS, short-lived authorization, no persistence, explicit mode
   labeling, and the local offline fallback.
