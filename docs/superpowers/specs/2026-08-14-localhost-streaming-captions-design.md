# Localhost Streaming Captions Design

**Date:** 2026-08-14

**Status:** Approved for implementation

**Builds on:** `2026-08-08-whisper-cpp-vad-migration-design.md`,
`2026-08-11-streaming-whisper-service-design.md`

**Supersedes for first implementation:** the 2026-08-11 streaming service as a
cloud GPU / multi-session deployment. This spec is the first shipping path:
live captions on the same PC, localhost only, one warm native Whisper process.

## Purpose

Show source-language captions **while the speaker is still talking**, then lock
an accurate line shortly after they pause. Audio never leaves this computer.

The current browser engine cannot do that. It waits for Silero VAD to flush an
utterance, then runs one-thread WebAssembly `whisper_full`. A measured 2.088 s
utterance took about 42–47 s to decode in Chromium. The UI and
`TranscriptSegment.isFinal` already support live revisions; the live engine
never emits them.

This design keeps the tested microphone capture, session lifecycle, engine
contract, reducer, and WASM fallback. Inference for the default live mode moves
to a native whisper.cpp process on the same PC. Whisper is loaded once when
that process starts and stays in memory until the process exits.

Whisper is not a token-streaming ASR. Live captions here mean rolling-window
re-decodes that rewrite one caption in place, not word-by-word tokens from a
different engine.

## Goals

- After the local server is warm, show a first provisional caption within 1.5 s
  of speech beginning on this PC.
- Refresh that same caption at least once per second while speech continues.
- Emit a final caption within 1.5 s after 500 ms of trailing silence.
- Keep Whisper and Silero loaded for the life of the server process. Start and
  Stop in the browser must not reload weights.
- Preserve multilingual Whisper for `vi-VN`, `en-US`, `es-ES`, and `zh-CN`.
  Never ship an `.en` model on the live path.
- Keep the existing 16 kHz mono 20 ms PCM frame contract and revision-safe
  reducer.
- Bind the server to loopback only.
- Keep the browser WASM engine as an explicit **Offline local** fallback.
- Keep audio and captions ephemeral: no recordings, no transcript files.

## Non-goals

- Conversational AI replies, translation, TTS, diarization, or memory.
- True word-by-word token streaming from a non-Whisper ASR.
- Cloud, LAN, or authenticated public deployment in this phase.
- Idle-timeout unload of the warm model.
- Automatic failover from live to offline in the middle of an utterance.
- Siri, App Intents, or an iOS app in this phase.
- Training or fine-tuning Whisper.
- Arbitrary audio formats.

## Approaches considered

| Approach | Benefits | Costs | Decision |
| --- | --- | --- | --- |
| Native whisper.cpp on this PC behind a localhost WebSocket | Reuses pinned runtime and contracts; GPU if present, else CPU; audio stays local | Windows native addon to maintain | **Chosen** |
| Rolling `whisper_full` in the current WASM engine | No extra process | ~20× slower than realtime; captions still lag | Rejected as the live path |
| Python `faster-whisper` sidecar | Often easy on Windows | Second Whisper stack beside pinned whisper.cpp | Benchmark fallback only if the native addon misses latency on this PC |

## Architecture

```text
Microphone (unchanged 20 ms PCM)
    │
    ▼
apps/web  SessionController
    │  EngineFactory
    ├─ default: packages/remote-whisper-engine  (Live, this PC)
    │                 │
    │                 │  ws://127.0.0.1:<port>
    │                 │  subprotocol voice-transcription.v1
    │                 ▼
    │            apps/transcription-server
    │                 │
    │                 ▼
    │            packages/native-whisper-addon
    │                 │  one warm whisper.cpp + Silero context
    │                 ▼
    └─ fallback: packages/local-whisper-engine  (Offline local WASM)
                      EngineEvent → sessionReducer → UI
```

The browser never talks to GPU APIs. The native addon is compiled for this
machine (CUDA or Vulkan if available at build time, otherwise CPU). The
handshake reports the loaded model name and backend; the UI only distinguishes
**Live (this PC)** from **Offline local**.

One server process, one native decoder context, one active listen session.

### Repository boundaries

- `packages/streaming-protocol/` — wire schemas, 656-byte PCM codec, validation
  shared by browser and server.
- `packages/remote-whisper-engine/` — `TranscriptionEngine` over the socket. No
  React state.
- `apps/transcription-server/` — loopback WebSocket, session scheduling,
  rolling decode, mapping native results to `EngineEvent`.
- `packages/native-whisper-addon/` — persistent whisper.cpp + Silero, async
  decode. Patterned on the pinned upstream N-API example. Do not patch
  `vendor/whisper.cpp`.
- `packages/local-whisper-engine/` — unchanged offline fallback.
- `apps/web/` — selects the live engine by default when the localhost URL is
  configured. UI does not open sockets directly.

## Warm model

1. Starting `apps/transcription-server` loads Whisper and Silero **before** it
   accepts a `session.start`. Disk-to-RAM load happens once per process.
2. The native contexts remain alive across `Start`, `Stop`, `Cancel`, Clear and
   Restart, and successive utterances.
3. There is no idle unload. The model leaves memory only when the server
   process exits.
4. If a client connects while load is still in progress, `prepare()` waits and
   the UI shows preparing. It must not open the microphone until
   `session.accepted`.
5. A native crash dies with a fatal session error. Restarting the server
   process is the only reload path.

## Wire protocol

WebSocket subprotocol: `voice-transcription.v1`.

This phase accepts only `ws://127.0.0.1` and `ws://localhost`. Non-loopback
binds and connects are refused. `wss:` and authentication are deferred until a
later non-localhost deployment.

Default development URL: `ws://127.0.0.1:8787`. The web app reads it from
`VITE_TRANSCRIPTION_WS_URL`.

### Client control messages

```ts
type ClientControl =
  | { type: "session.start"; protocol: 1; request: SessionRequest }
  | { type: "session.stop"; sessionId: string }
  | { type: "session.cancel"; sessionId: string };
```

`SessionRequest` is the existing contracts type (`mode: "transcribe"`, 16 kHz
mono PCM, 1–4 candidate languages).

One socket owns at most one session. Binary audio messages do not repeat the
session ID.

Every audio message is exactly 656 bytes:

| Bytes | Content |
| --- | --- |
| 0 | protocol version `1` |
| 1 | message type `1` (PCM) |
| 2–3 | reserved, must be zero |
| 4–7 | unsigned little-endian frame sequence |
| 8–15 | little-endian Float64 `startMs` |
| 16–655 | exactly 320 signed little-endian 16-bit samples |

The protocol package rejects malformed headers, wrong sizes, nonzero reserved
bytes, non-monotonic sequences, and unsupported versions.

### Server messages

```ts
type ServerMessage =
  | { type: "session.accepted"; sessionId: string; model: string; backend: "cpu" | "cuda" | "vulkan" | "metal" }
  | { type: "audio.ack"; sessionId: string; throughSequence: number }
  | { type: "engine.event"; event: EngineEvent };
```

`EngineEvent` stays the application contract. React and the reducer never see
whisper.cpp types. `audio.ack` bounds the client unacked-frame queue.

Unknown or malformed messages terminate only that session with a normalized
fatal error.

## Streaming transcription flow

1. `prepare()` opens the socket and waits until the server can accept a session
   (model already warm, or still loading on a fresh process).
2. `open()` sends `session.start`. The server validates candidate languages. If
   another listen is already active, it rejects with `RESOURCE_EXHAUSTED`.
   Otherwise it returns `session.accepted`.
3. `push()` writes each existing PCM frame and returns synchronously.
   Backpressure is reported only when the unacked-frame queue is full or the
   socket cannot accept data.
4. Native Silero VAD (same policy as the browser engine: threshold 0.5, min
   speech 250 ms, min silence 500 ms, max speech 25 s, pad 100 ms) marks speech
   start and the final boundary. VAD does **not** block provisional decoding.
5. After speech has started, the scheduler requests a rolling decode every
   750 ms. The window is the current utterance audio, capped at the latest 8 s
   plus 500 ms overlap and the last stable prompt. One decode at a time. Ticks
   that arrive during a decode coalesce into one newest-window request.
6. Each provisional result upserts the current segment with the same `id` and
   `ordinal`, incremented `revision`, and `isFinal: false`.
7. After 500 ms trailing silence, one full-utterance decode upserts
   `isFinal: true`. The next speech run gets a new segment id and ordinal.
8. Unbroken speech at 25 s is finalized and a new live segment starts, staying
   under Whisper's 30 s encoder window.
9. `stop()` drains buffered speech, emits a final if there was speech, emits
   `stopped`, and closes the session without unloading the model. `cancel()`
   drops buffered audio immediately and also leaves the model loaded.

Early provisionals may use language `und`. Finals run acoustic language
detection and map through the existing candidate-language policy.

This is rolling live captions, not “wait for a chunk then transcribe once.”
The 750 ms figure is a refresh interval. Audio is sent every 20 ms from the
moment listening starts.

## Model and accuracy policy

Live-path weights are **server** assets, not the browser `tiny` manifest.
Checksum-verified fetch lives in an install/dev script (same style as
`scripts/fetch-models.mjs`) into a server-local directory. The browser runtime
still only uses same-origin `/models/...` for the WASM fallback.

Default live candidate is multilingual `small`. If this PC misses the latency
goals on CPU, drop to multilingual `base`. If it has headroom (typically a
GPU), try multilingual `medium` and keep it only when every latency goal still
holds. English-only models are prohibited.

Quantization is allowed only when, against the same unquantized tier,
aggregate WER for alphabetic fixtures and CER for Mandarin regress by at most
one absolute point, and no language regresses by more than two points.

Provisional text may change. Final text is immutable under the existing
reducer rule.

## Capacity and backpressure

- One native context, one decode at a time, one active listen session.
- A second `session.start` while a session is live is `RESOURCE_EXHAUSTED`.
- Session limits: bounded PCM buffer, max duration, idle time, message rate,
  unacked bytes.
- Rolling ticks coalesce. Never queue historical provisional jobs.
- Final decodes preempt provisional refreshes.
- Metrics (no audio or caption text): queue delay, decode duration, audio
  duration, real-time factor, whether the native context was already warm.

Target on this PC after warmup: decoder real-time factor below `1.0` for
provisional windows and below `0.5` when a GPU backend is active. CPU-only may
miss the 1.5 s / 1 s / 1.5 s UI goals with `small`; then the default model
steps down as specified above rather than faking live behavior.

## Security and privacy

- Listen on `127.0.0.1` only. Refuse `0.0.0.0` and non-loopback clients.
- No authentication in this phase because the socket is loopback-only.
- Origin allowlist still applies (the Vite/app origin). Schema validation,
  payload size limits, and one-session concurrency remain.
- Audio and captions stay in memory and are released when the session ends.
- Logs may include opaque session ids, timings, sizes, model name, backend,
  error codes, and resource usage. Never audio or caption text.

## Failure handling

- Server process not running: Live mode fails `prepare()` / `open()` with
  `UNAVAILABLE`. The microphone does not start. The user can choose
  **Offline local**. No automatic mid-utterance switch.
- Model still loading: UI stays on preparing; mic stays closed until
  `session.accepted`.
- Socket loss: one fatal `UNAVAILABLE`, stop capture, keep already-final
  segments.
- Decode slower than the window: drop extra ticks, keep the newest window.
  After three consecutive slower-than-realtime provisionals, emit
  `DEGRADED_PERFORMANCE`.
- Decode timeout: recycle the unhealthy native context (this **does** reload
  weights, because the context is dead), emit `TIMEOUT`.
- Sequence gap: `AUDIO_GAP`; continue if the gap is bounded.
- Invalid protocol or audio: terminate with `INVALID_AUDIO` or `UNSUPPORTED`.
- Native crash: fatal `INTERNAL` for that session; operator restarts the
  server to warm the model again.

## UI

- Replace the hard-coded “Local transcription (on this device)” string with an
  explicit mode: **Live (this PC)** or **Offline local**.
- Default is Live when `VITE_TRANSCRIPTION_WS_URL` is set (dev default:
  `ws://127.0.0.1:8787`). Offline is a user-visible control, not a hidden
  fallback.
- One keyed paragraph per segment. Provisional segments use a distinct class
  and `data-final="false"`. Visual opacity plus a non-color-only “Updating”
  label.
- Visible transcript uses `aria-live="off"`. A screen-reader-only polite
  region announces listening status and **final** segments only, so a line
  that revises every 750 ms is not reread each time.

## Testing

### Unit and contract

- PCM codec round-trip; reject malformed frames, bad versions, and
  non-monotonic sequences.
- `RemoteWhisperEngine` passes the existing `TranscriptionEngine` contract
  suite.
- Socket lifecycle: prepare / open / stop / cancel, late events, disconnect,
  dispose.
- Ack backpressure ordering.
- Scheduler: first provisional, later same-id revisions, one final after
  500 ms silence, tick coalescing, final-decode priority, 25 s split.
- Warm model: two back-to-back sessions against an injected fake runtime show
  native `load` count `1`.
- Stop emits a final if speech existed; Cancel emits none.
- Localhost bind: non-loopback listen/connect refused.
- Native wrapper tests use a fake runtime in ordinary CI (no GPU required).

### Integration and browser

- In-process WebSocket server drives real binary frames through
  `SessionController` and the reducer.
- Playwright: live text appears before final text; later revisions replace
  the same paragraph. Offline local still works with the server down.
- Existing WASM engine, reducer, microphone, stop/cancel/restart, and
  permission-denied tests stay green.

### Native verification on this PC

- Smoke: process start loads the multilingual model once and transcribes
  fixture PCM with no temp files. A second session does not load again.
- Local benchmark (not every CI run): first-provisional latency, refresh
  interval, final-after-silence latency, decode time, real-time factor,
  whether GPU is active.
- Accuracy on clean and noisy English, Vietnamese, Spanish, and Mandarin
  fixtures. Model choice is not accepted from speed alone.

## Delivery sequence

1. Versioned `packages/streaming-protocol` with tests.
2. `RemoteWhisperEngine` against a fake WebSocket, passing the contract suite.
3. Transcription-server session machine with an injected fake native runtime,
   including warm-load-once and localhost bind.
4. Native addon from the pinned upstream N-API pattern; Windows build docs;
   no `vendor/whisper.cpp` edits.
5. Checksum-verified live-model fetch; benchmark `base` / `small` / `medium`
   on this PC; pick the default from evidence.
6. Wire the web app: Live default, Offline control, provisional styling and
   accessibility.
7. Lifecycle, Playwright, localhost security, latency, and multilingual
   checks.
8. Document: start the warm server, start the web app, switch to Offline,
   Windows native build, model directory.

## Acceptance criteria

- Existing local-engine, reducer, lifecycle, and microphone tests remain green.
- Remote engine passes the reusable contract suite.
- A real browser shows a non-final caption before the final caption for one
  continuous utterance, and revisions do not duplicate paragraphs.
- After the server process is warm, on this PC: first provisional p95 ≤ 1.5 s
  after speech starts; refresh p95 ≤ 1 s; final p95 ≤ 1.5 s after the 500 ms
  silence boundary. If CPU-only `small` misses that, the documented default
  becomes the largest multilingual model that meets the gates.
- Native `load` is invoked once per server process in the warm-model test, not
  once per listen.
- The server refuses non-loopback binding.
- Final segments never regress, duplicate, or reorder after revisions.
- Malformed messages, audio gaps, disconnects, stop, cancel, and restart have
  bounded deterministic behavior.
- The browser bundle contains no native binaries and no live-path model
  weights.
- Audio and caption text are absent from logs and are not stored.
- Docs distinguish Live (this PC) from slower Offline local WASM.

## Risks

1. **CPU latency on this Windows PC.** Native is far faster than WASM but may
   still miss 1.5 s with `small`. Mitigation: measure, step down to `base`,
   keep `faster-whisper` as a measured escape hatch, never pretend WASM is live.
2. **Partial caption flicker.** Whisper re-decodes a window, so wording can
   jump. Mitigation: stable segment ids, revision upserts, and a final
   full-utterance pass.
3. **Windows native addon.** N-API + whisper.cpp build cost. Mitigation: fake
   runtime in CI, pinned build instructions, do not modify the submodule.
4. **Operator must run two processes.** If the server is down, Live fails
   closed. Mitigation: clear UNAVAILABLE error and an explicit Offline mode.
5. **Native context recycle after timeout.** That path reloads weights.
   Mitigation: treat it as a rare recovery, not a listen-time cost; document
   that a healthy server stays warm.
