# Streaming Whisper Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make multilingual Whisper transcription appear provisionally while the speaker is talking and finalize accurately after silence, using a browser WebSocket client and a persistent GPU-capable native whisper.cpp service.

**Architecture:** Add a versioned binary/JSON protocol, a `RemoteWhisperEngine` that preserves the existing `TranscriptionEngine` boundary, and a Node WebSocket gateway with a pure session scheduler. The gateway delegates VAD and decode calls to a persistent N-API whisper.cpp runtime; the current browser-WASM engine remains an explicit offline fallback.

**Tech Stack:** TypeScript 6, Node.js, `ws`, Vitest, React 19, Playwright, C++17, N-API, CMake/cmake-js, whisper.cpp, Silero VAD, CUDA-capable production container.

**Spec:** `docs/superpowers/specs/2026-08-11-streaming-whisper-service-design.md`

---

## Global constraints

- Keep `SessionRequest` and `PcmFrame` unchanged: 16 kHz mono `pcm_s16le`, 320 samples, 20 ms.
- Preserve `segment.upsert` revision semantics; provisional segments reuse one ID and final segments are immutable.
- Use multilingual models only. Never configure a model whose name ends in `.en`.
- Do not patch `vendor/whisper.cpp`; all C++ glue lives under `packages/native-whisper-addon/`.
- Tests and TypeScript builds must run without a GPU, CMake, or native binary by injecting fake transports/runtimes.
- Native build and real GPU benchmark are explicit commands, not `postinstall` work.
- Production remote mode uses authenticated `wss:`. Development plaintext is allowed only for `127.0.0.1`/`localhost`.
- Every task follows red-green-refactor and ends in one focused commit.

## File structure

### New workspaces

| Path | Responsibility |
| --- | --- |
| `packages/streaming-protocol/` | Wire types, JSON validation, and exact 656-byte PCM codec |
| `packages/remote-whisper-engine/` | Browser WebSocket implementation of `TranscriptionEngine` |
| `apps/transcription-server/` | WebSocket admission, per-session scheduler, runtime pool, and metrics |
| `packages/native-whisper-addon/` | Persistent N-API whisper.cpp/Silero context and JS loader |

### Existing files modified

| Path | Change |
| --- | --- |
| `package.json` / `package-lock.json` | Add workspaces/dependencies and deterministic build order |
| `apps/web/src/features/transcription/sessionController.ts` | Provider-neutral backpressure text only |
| `apps/web/src/features/transcription/TranscriptionAdapter.tsx` | Remote default, offline fallback, provisional/final accessibility |
| `apps/web/src/app.css` | Provisional visual treatment |
| `apps/web/tests/e2e/transcription.spec.ts` | Partial-before-final browser path |
| `README.md`, `CLAUDE.md` | Remote/local modes, development, privacy, deployment |

---

### Task 1: Add the binary PCM protocol package

**Files:**
- Create: `packages/streaming-protocol/package.json`
- Create: `packages/streaming-protocol/tsconfig.json`
- Create: `packages/streaming-protocol/src/pcm.ts`
- Create: `packages/streaming-protocol/src/index.ts`
- Test: `packages/streaming-protocol/test/pcm.test.ts`
- Modify: `package-lock.json`

- [ ] **Step 1: Create the workspace manifest and TypeScript config**

```json
{
  "name": "@voice/streaming-protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit --pretty false"
  },
  "dependencies": { "@voice/transcription-contracts": "0.0.0" },
  "devDependencies": { "typescript": "6.0.3", "vitest": "4.1.10" }
}
```

Use the same `compilerOptions` as `packages/transcription-contracts/tsconfig.json`, with `rootDir: "src"` and `outDir: "dist"`.

- [ ] **Step 2: Write failing codec tests**

```ts
import { describe, expect, it } from "vitest";
import { decodePcmMessage, encodePcmMessage, PCM_MESSAGE_BYTES } from "../src/index.js";

describe("PCM wire codec", () => {
  it("round-trips the exact contract frame", () => {
    const samples = Int16Array.from({ length: 320 }, (_, index) => index - 160);
    const encoded = encodePcmMessage({ sequence: 7, startMs: 140, samples });
    expect(encoded.byteLength).toBe(656);
    expect(PCM_MESSAGE_BYTES).toBe(656);
    expect(decodePcmMessage(encoded)).toEqual({ sequence: 7, startMs: 140, samples });
  });

  it.each([
    new ArrayBuffer(655),
    new Uint8Array([2, 1, 0, 0, ...new Array(652).fill(0)]).buffer,
    new Uint8Array([1, 1, 1, 0, ...new Array(652).fill(0)]).buffer,
  ])("rejects malformed frames", (message) => {
    expect(() => decodePcmMessage(message)).toThrow();
  });
});
```

- [ ] **Step 3: Run the focused test and confirm red**

Run: `npx vitest run test/pcm.test.ts` from `packages/streaming-protocol`.

Expected: FAIL because `../src/index.js` does not exist.

- [ ] **Step 4: Implement the exact codec**

```ts
import type { PcmFrame } from "@voice/transcription-contracts";

export const PCM_PROTOCOL_VERSION = 1;
export const PCM_MESSAGE_TYPE = 1;
export const PCM_HEADER_BYTES = 16;
export const PCM_MESSAGE_BYTES = 656;

export function encodePcmMessage(frame: PcmFrame): ArrayBuffer {
  if (!(frame.samples instanceof Int16Array) || frame.samples.length !== 320) {
    throw new TypeError("PCM frame must contain 320 Int16 samples");
  }
  const buffer = new ArrayBuffer(PCM_MESSAGE_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, PCM_PROTOCOL_VERSION);
  view.setUint8(1, PCM_MESSAGE_TYPE);
  view.setUint16(2, 0, true);
  view.setUint32(4, frame.sequence, true);
  view.setFloat64(8, frame.startMs, true);
  for (let index = 0; index < 320; index += 1) {
    view.setInt16(PCM_HEADER_BYTES + index * 2, frame.samples[index]!, true);
  }
  return buffer;
}

export function decodePcmMessage(buffer: ArrayBuffer): PcmFrame {
  if (buffer.byteLength !== PCM_MESSAGE_BYTES) throw new RangeError("PCM message must be 656 bytes");
  const view = new DataView(buffer);
  if (view.getUint8(0) !== PCM_PROTOCOL_VERSION) throw new TypeError("unsupported PCM protocol version");
  if (view.getUint8(1) !== PCM_MESSAGE_TYPE) throw new TypeError("unsupported binary message type");
  if (view.getUint16(2, true) !== 0) throw new TypeError("reserved PCM header bytes must be zero");
  const samples = new Int16Array(320);
  for (let index = 0; index < 320; index += 1) {
    samples[index] = view.getInt16(PCM_HEADER_BYTES + index * 2, true);
  }
  return { sequence: view.getUint32(4, true), startMs: view.getFloat64(8, true), samples };
}
```

Export every symbol from `src/index.ts` with `export * from "./pcm.js";`.

- [ ] **Step 5: Verify green and build**

Run: `npm test --workspace @voice/streaming-protocol && npm run build --workspace @voice/streaming-protocol`

Expected: codec tests PASS and `dist/` is generated.

- [ ] **Step 6: Commit**

```bash
git add package-lock.json packages/streaming-protocol
git commit -m "feat: add streaming PCM wire codec"
```

---

### Task 2: Add control/event types and runtime validation

**Files:**
- Create: `packages/streaming-protocol/src/messages.ts`
- Create: `packages/streaming-protocol/src/validation.ts`
- Modify: `packages/streaming-protocol/src/index.ts`
- Test: `packages/streaming-protocol/test/messages.test.ts`

- [ ] **Step 1: Write failing message-validation tests**

```ts
import { describe, expect, it } from "vitest";
import { validateClientControl, validateServerMessage } from "../src/index.js";

const request = {
  sessionId: "session-1",
  candidateLanguages: ["en-US", "vi-VN"],
  mode: "transcribe",
  audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
} as const;

describe("streaming messages", () => {
  it("accepts the three client controls", () => {
    expect(validateClientControl({ type: "session.start", protocol: 1, request })).toMatchObject({ type: "session.start" });
    expect(validateClientControl({ type: "session.stop", sessionId: "session-1" })).toMatchObject({ type: "session.stop" });
    expect(validateClientControl({ type: "session.cancel", sessionId: "session-1" })).toMatchObject({ type: "session.cancel" });
  });

  it("rejects unknown controls and invalid engine events", () => {
    expect(() => validateClientControl({ type: "session.pause" })).toThrow();
    expect(() => validateServerMessage({ type: "engine.event", event: { type: "state" } })).toThrow();
  });
});
```

- [ ] **Step 2: Confirm red**

Run: `npx vitest run test/messages.test.ts` from the protocol workspace.

Expected: FAIL because validators are not exported.

- [ ] **Step 3: Define the wire types**

```ts
import type { EngineEvent, SessionRequest } from "@voice/transcription-contracts";

export type ClientControl =
  | { type: "session.start"; protocol: 1; request: SessionRequest }
  | { type: "session.stop"; sessionId: string }
  | { type: "session.cancel"; sessionId: string };

export type ServerMessage =
  | { type: "session.accepted"; sessionId: string; model: string }
  | { type: "audio.ack"; sessionId: string; throughSequence: number }
  | { type: "engine.event"; event: EngineEvent };
```

- [ ] **Step 4: Implement validators without a new schema dependency**

Use `validateSessionRequest` for `session.start`. Validate nonempty session/model strings, nonnegative integer acknowledgements, and every `EngineEvent` discriminant plus its required fields. Reject unknown object keys only at the top-level wire message; the existing engine-contract validator remains authoritative for request content. Export the types and validators from `src/index.ts`.

The validator signatures are exact:

```ts
export function validateClientControl(value: unknown): ClientControl;
export function validateServerMessage(value: unknown): ServerMessage;
export function parseJsonMessage(text: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch { throw new TypeError("message must be valid JSON"); }
}
```

- [ ] **Step 5: Verify package tests and generated declarations**

Run: `npm test --workspace @voice/streaming-protocol && npm run build --workspace @voice/streaming-protocol`

Expected: all protocol tests PASS and `dist/index.d.ts` exports the two validators.

- [ ] **Step 6: Commit**

```bash
git add packages/streaming-protocol
git commit -m "feat: validate streaming control messages"
```

---

### Task 3: Implement the remote engine lifecycle

**Files:**
- Create: `packages/remote-whisper-engine/package.json`
- Create: `packages/remote-whisper-engine/tsconfig.json`
- Create: `packages/remote-whisper-engine/src/socket.ts`
- Create: `packages/remote-whisper-engine/src/RemoteWhisperEngine.ts`
- Create: `packages/remote-whisper-engine/src/index.ts`
- Test: `packages/remote-whisper-engine/test/RemoteWhisperEngine.test.ts`
- Test: `packages/remote-whisper-engine/test/contract.test.ts`
- Modify: `package-lock.json`

- [ ] **Step 1: Create the workspace**

Name it `@voice/remote-whisper-engine`. Depend on `@voice/transcription-contracts` and `@voice/streaming-protocol`; use TypeScript/Vitest versions already pinned in the repo. Build to committed `dist/` like the existing engine packages.

- [ ] **Step 2: Define the injectable socket seam**

```ts
export interface SocketEventMap {
  open: Event;
  message: MessageEvent<string | ArrayBuffer>;
  close: CloseEvent;
  error: Event;
}

export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: BinaryType;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void): void;
  removeEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void): void;
}

export type SocketFactory = (url: string, protocols: readonly string[]) => SocketLike;
```

The production factory returns `new WebSocket(url, [...protocols])`.

- [ ] **Step 3: Write red lifecycle tests**

Use a deterministic `FakeSocket` that records sent values and can emit open/message/close. Assert:

```ts
await engine.prepare(request);
const opening = engine.open(request);
socket.emitJson({ type: "session.accepted", sessionId: request.sessionId, model: "small" });
const session = await opening;
expect(socket.sentJson()).toContainEqual({ type: "session.start", protocol: 1, request });
```

Also assert that `inspect()` rejects non-`wss:` non-loopback URLs, `open()` before `prepare()` fails, cancel sends `session.cancel`, and a socket close emits one fatal `UNAVAILABLE` followed by `stopped`.

- [ ] **Step 4: Confirm red**

Run: `npm test --workspace @voice/remote-whisper-engine`

Expected: FAIL because `RemoteWhisperEngine` is missing.

- [ ] **Step 5: Implement lifecycle and message delivery**

Use this public options shape:

```ts
export interface RemoteWhisperEngineOptions {
  endpoint: string;
  tokenProvider?: () => string | Promise<string>;
  socketFactory?: SocketFactory;
  maxUnacknowledgedFrames?: number;
}
```

`prepare()` opens one socket with subprotocol `voice-transcription.v1` and, when a token exists, adds it as a URL query parameter named `access_token`. `open()` sends `session.start` and resolves only after matching `session.accepted`. The session replays its `listening` event to the first subscriber, validates every server message, forwards only matching-session `engine.event` values, and makes terminal methods idempotent. `dispose()` cancels an active session and closes the socket exactly once.

- [ ] **Step 6: Add the shared contract suite**

Drive the fake socket automatically: accept the session on start, ACK frames, and on stop emit `draining`, one final segment, then `stopped`. Use `describeEngineContract("remote whisper", createEngine, fixture)` from `@voice/transcription-contracts/testing`.

- [ ] **Step 7: Verify green**

Run: `npm test --workspace @voice/remote-whisper-engine && npm run typecheck --workspace @voice/remote-whisper-engine`

Expected: lifecycle and shared contract tests PASS.

- [ ] **Step 8: Commit**

```bash
git add package-lock.json packages/remote-whisper-engine
git commit -m "feat: add remote whisper engine lifecycle"
```

---

### Task 4: Add credit-based audio backpressure

**Files:**
- Modify: `packages/remote-whisper-engine/src/RemoteWhisperEngine.ts`
- Test: `packages/remote-whisper-engine/test/backpressure.test.ts`

- [ ] **Step 1: Write red backpressure tests**

With `maxUnacknowledgedFrames: 2`, assert the first two `push()` calls return `{ accepted: true }`, the third returns `{ accepted: false, reason: "backpressure" }`, ACK through sequence 0 permits one more frame, duplicate/regressing ACKs do not add credit, and ACK beyond the highest sent sequence is a fatal protocol error.

- [ ] **Step 2: Confirm red**

Run: `npx vitest run test/backpressure.test.ts` from the remote-engine workspace.

Expected: FAIL because pushes are not credit-bounded.

- [ ] **Step 3: Implement bounded unacknowledged sequence tracking**

Maintain `lowestUnackedSequence`, `highestSentSequence`, and a `Set<number>` of outstanding sequences. Call `encodePcmMessage(frame)` only after capacity validation. Do not accept a frame when `socket.bufferedAmount > 1_048_576`. Remove all outstanding sequences `<= throughSequence` on a valid ACK. Terminal sessions consistently return the contract's backpressure result.

- [ ] **Step 4: Verify green and full package contract**

Run: `npm test --workspace @voice/remote-whisper-engine`

Expected: all tests PASS, including the shared contract suite.

- [ ] **Step 5: Commit**

```bash
git add packages/remote-whisper-engine
git commit -m "feat: bound remote audio backpressure"
```

---

### Task 5: Build the pure server session scheduler

**Files:**
- Create: `apps/transcription-server/package.json`
- Create: `apps/transcription-server/tsconfig.json`
- Create: `apps/transcription-server/src/runtime.ts`
- Create: `apps/transcription-server/src/vadGate.ts`
- Create: `apps/transcription-server/src/languageMap.ts`
- Create: `apps/transcription-server/src/sessionScheduler.ts`
- Test: `apps/transcription-server/test/vadGate.test.ts`
- Test: `apps/transcription-server/test/languageMap.test.ts`
- Test: `apps/transcription-server/test/sessionScheduler.test.ts`
- Modify: `package-lock.json`

- [ ] **Step 1: Create the server workspace**

Name it `@voice/transcription-server`; depend on the contracts, streaming protocol, and `ws`. Add `@types/ws`, TypeScript, and Vitest as development dependencies. Provide scripts `build`, `test`, `typecheck`, and `dev: "node dist/main.js"`.

- [ ] **Step 2: Define the native-independent runtime seam**

```ts
import type { PcmFrame, SessionRequest } from "@voice/transcription-contracts";

export interface VadUpdate { speechStarted: boolean; speechEnded: boolean; }
export interface DecodeResult { text: string; language: string; startMs: number; endMs: number; }
export interface StreamingRuntimeSession {
  push(frame: PcmFrame): VadUpdate;
  decode(kind: "provisional" | "final", audio: Int16Array, prompt: string): Promise<DecodeResult>;
  close(): Promise<void>;
}
export interface StreamingRuntime {
  readonly modelName: string;
  open(request: SessionRequest): Promise<StreamingRuntimeSession>;
}
```

`StreamingRuntimeSession.push()` returns boundary updates, but the native
adapter in Task 9 derives them in TypeScript: the addon returns consecutive
Silero probabilities, and a pure server `VadGate` applies threshold `0.5`,
minimum speech `250 ms`, trailing silence `500 ms`, maximum speech `25,000 ms`,
and padding metadata. Port the existing gate behavior with focused tests rather
than importing the browser-local engine. `languageMap.ts` independently maps
Whisper's ISO language code to the request's BCP-47 candidates or `und`, with
the same cases as the existing local-engine tests.

- [ ] **Step 3: Write red scheduler tests with fake timers/runtime**

Assert that speech start schedules no decode before 750 ms, the first tick emits revision 0 non-final, a second tick emits revision 1 with the same ID, ticks coalesce while a decode promise is pending, speech end prioritizes exactly one final decode, final emits revision 2 and becomes immutable, stop drains speech, and cancel emits no segment after cancellation.

- [ ] **Step 4: Confirm red**

Run: `npm test --workspace @voice/transcription-server`

Expected: FAIL because `SessionScheduler` is missing.

- [ ] **Step 5: Implement scheduler state and event sequencing**

Constructor shape:

```ts
export interface SessionSchedulerOptions {
  request: SessionRequest;
  runtime: StreamingRuntimeSession;
  emit(event: EngineEvent): void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  decodeIntervalMs?: number;
  maxWindowMs?: number;
  overlapMs?: number;
}
```

Defaults are 750 ms, 8,000 ms, and 500 ms. Buffer accepted PCM in chronological order, retain at most the active utterance plus overlap, serialize decodes, and replace any pending provisional request with the newest window. A pending final request supersedes provisional work. Use segment ID `${sessionId}:${ordinal}`, increment `revision` per emitted hypothesis, and map provisional language to `und`. Final language uses the existing candidate-language mapping rule.

- [ ] **Step 6: Verify green**

Run: `npm test --workspace @voice/transcription-server && npm run typecheck --workspace @voice/transcription-server`

Expected: scheduler tests PASS without a native binary.

- [ ] **Step 7: Commit**

```bash
git add package-lock.json apps/transcription-server
git commit -m "feat: schedule rolling transcript revisions"
```

---

### Task 6: Add WebSocket admission and gateway handling

**Files:**
- Create: `apps/transcription-server/src/admission.ts`
- Create: `apps/transcription-server/src/gateway.ts`
- Create: `apps/transcription-server/src/metrics.ts`
- Create: `apps/transcription-server/src/main.ts`
- Test: `apps/transcription-server/test/gateway.test.ts`
- Test: `apps/transcription-server/test/metrics.test.ts`

- [ ] **Step 1: Write red integration tests using a real loopback `ws` server**

Use port `0` and an injected fake runtime. Cover accepted `session.start`, binary PCM decode and ACK, one active session per socket, stop/cancel, malformed JSON, malformed 656-byte PCM, sequence gaps, origin rejection, capacity rejection before acceptance, and release of admission capacity on close.

Add a metrics test that records queue delay, decode duration, audio duration,
real-time factor, model, result kind, and opaque session ID, then serializes the
record and proves it contains neither sample buffers nor transcript text.

- [ ] **Step 2: Confirm red**

Run: `npx vitest run test/gateway.test.ts` from the server workspace.

Expected: FAIL because the gateway does not exist.

- [ ] **Step 3: Implement admission control**

```ts
export class AdmissionPool {
  private active = 0;
  public constructor(private readonly capacity: number) {}
  public reserve(): (() => void) | undefined {
    if (this.active >= this.capacity) return undefined;
    this.active += 1;
    let released = false;
    return () => { if (!released) { released = true; this.active -= 1; } };
  }
}
```

- [ ] **Step 4: Implement the gateway**

Expose `createTranscriptionGateway({ server, runtime, capacity, allowedOrigins, authenticate })`. Require subprotocol `voice-transcription.v1`, validate the first text message as `session.start`, reserve capacity before `runtime.open`, and emit `session.accepted` only afterward. Validate every binary frame with `decodePcmMessage`; emit `audio.ack` after the scheduler accepts it. Normalize errors to contract codes and close with application close code `4000` after the terminal event.

Read `access_token` from the upgrade request URL, remove it before any request
logging, and pass it to `authenticate(token)`, which returns
`{ accountId: string }` or throws. `main.ts` reads `VOICE_MODEL_PATH`,
`VOICE_VAD_MODEL_PATH`, `VOICE_PORT`, `VOICE_ALLOWED_ORIGINS`, and
`VOICE_MAX_SESSIONS`; missing production values fail startup with one explicit
error.

`metrics.ts` exports a `MetricsSink` interface and a JSON-lines implementation.
The scheduler reports numeric timings and enums only; its API accepts no text or
PCM fields, making content logging impossible through this path.

- [ ] **Step 5: Verify server tests**

Run: `npm test --workspace @voice/transcription-server && npm run build --workspace @voice/transcription-server`

Expected: gateway and scheduler tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/transcription-server
git commit -m "feat: serve streaming transcription sessions"
```

---

### Task 7: Wire remote mode into the web UI

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/features/transcription/sessionController.ts`
- Modify: `apps/web/src/features/transcription/TranscriptionAdapter.tsx`
- Modify: `apps/web/src/app.css`
- Modify: `apps/web/src/features/transcription/TranscriptionAdapter.test.tsx`
- Modify: `apps/web/tests/e2e/transcription.spec.ts`
- Modify: `package-lock.json`

- [ ] **Step 1: Add the remote-engine dependency and red UI tests**

Test that default construction uses `RemoteWhisperEngine` when `VITE_TRANSCRIPTION_WS_URL` is configured, the UI labels it `Online real-time`, an explicit mode control selects `Offline local`, a non-final segment has class `transcript-segment--provisional`, and a later final revision replaces the same paragraph rather than appending another.

Add an accessibility assertion: the rapidly revised visual container is `aria-live="off"`, while a visually hidden `aria-live="polite"` region contains finalized segment text only.

- [ ] **Step 2: Confirm red**

Run: `npm test --workspace @voice/web -- TranscriptionAdapter.test.tsx`

Expected: FAIL because the mode selector and provisional markup do not exist.

- [ ] **Step 3: Implement engine selection at the adapter seam**

```ts
type EngineMode = "remote" | "local";

function createEngine(mode: EngineMode, onProgress: (value: number) => void): TranscriptionEngine {
  if (mode === "local") return new LocalWhisperEngine({ onProgress });
  const endpoint = import.meta.env.VITE_TRANSCRIPTION_WS_URL;
  if (!endpoint) throw new Error("VITE_TRANSCRIPTION_WS_URL is required for online real-time mode");
  const tokenUrl = import.meta.env.VITE_TRANSCRIPTION_TOKEN_URL ?? "/api/transcription-token";
  return new RemoteWhisperEngine({
    endpoint,
    tokenProvider: async () => {
      const response = await fetch(tokenUrl, { credentials: "include" });
      if (!response.ok) throw new Error("Unable to authorize transcription");
      const value = await response.json() as { token?: unknown };
      if (typeof value.token !== "string" || value.token.length === 0) {
        throw new Error("Transcription authorization returned no token");
      }
      return value.token;
    },
  });
}
```

Keep the injected `engineFactory` behavior for tests. When the user changes mode, stop the current session and construct a fresh controller engine on the next start. Update the backpressure warning from "local model" to "transcription service".

Reintroduce a provider-neutral controller reset method and drive the factory
from a current mode ref:

```ts
public async resetEngine(): Promise<void> {
  await this.stop();
  await this.dropEngine();
}
```

On mode change, update `engineModeRef.current`, await
`controller.resetEngine()`, and only then enable Start. This prevents reuse of
the cached engine from the previous mode.

- [ ] **Step 4: Render provisional and final text accessibly**

Use one keyed paragraph per segment. Add the provisional class and `data-final` attribute. Set the visual transcript to `aria-live="off"`; add a screen-reader-only polite region rendering only final segments. Style provisional text with reduced opacity and a non-color-only `Updating` label.

- [ ] **Step 5: Add the Playwright partial-before-final scenario**

Inject a fake remote engine through the existing test seam. Emit revision 0 non-final text `"I would"`, then revision 1 `"I would like"`, then revision 2 final `"I would like to reserve a room."`. Assert there is always one segment paragraph and final text appears before `stopped`.

- [ ] **Step 6: Verify web tests and typecheck**

Run: `npm test --workspace @voice/web && npm run typecheck --workspace @voice/web`

Expected: unit tests PASS. Then run `npm run test:e2e --workspace @voice/web -- --grep "partial"`; expected PASS.

- [ ] **Step 7: Commit**

```bash
git add package-lock.json apps/web
git commit -m "feat: show remote whisper transcript revisions"
```

---

### Task 8: Create the persistent native whisper.cpp addon

**Files:**
- Create: `packages/native-whisper-addon/package.json`
- Create: `packages/native-whisper-addon/CMakeLists.txt`
- Create: `packages/native-whisper-addon/native/addon.cpp`
- Create: `packages/native-whisper-addon/src/types.ts`
- Create: `packages/native-whisper-addon/src/loader.ts`
- Create: `packages/native-whisper-addon/src/index.ts`
- Test: `packages/native-whisper-addon/test/loader.test.ts`
- Modify: `package-lock.json`

- [ ] **Step 1: Create a workspace whose ordinary build does not compile C++**

Add `build: "tsc -p tsconfig.json"`, `build:native: "cmake-js compile -T native-whisper-addon -B Release"`, and no install hook. Depend on `node-addon-api`; keep `cmake-js` and TypeScript as development dependencies.

- [ ] **Step 2: Write red loader tests**

Inject `loadBinary(path)` into `loadNativeWhisperAddon`. Assert a missing binary produces `Native whisper addon is not built; run npm run build:native --workspace @voice/native-whisper-addon`, and a fake binary is shape-checked for `createRuntime`.

- [ ] **Step 3: Confirm red**

Run: `npm test --workspace @voice/native-whisper-addon`

Expected: FAIL because the loader does not exist.

- [ ] **Step 4: Define the JS/native API**

```ts
export interface NativeDecodeResult { text: string; language: string; startMs: number; endMs: number; }
export interface NativeRuntimeHandle {
  pushVad(samples: Int16Array): Float32Array;
  decode(samples: Int16Array, prompt: string): Promise<NativeDecodeResult>;
  warmup(): Promise<void>;
  reset(): void;
  close(): void;
}
export interface NativeAddon {
  createRuntime(options: { modelPath: string; vadModelPath: string; threads: number; useGpu: boolean }): NativeRuntimeHandle;
}
```

- [ ] **Step 5: Implement CMake and the persistent `ObjectWrap`**

Link `node-addon-api` and `${CMAKE_CURRENT_SOURCE_DIR}/../../vendor/whisper.cpp`.
Define `WHISPER_BUILD_EXAMPLES`, `WHISPER_BUILD_TESTS`, and
`WHISPER_BUILD_SERVER` off. `WhisperRuntimeWrap` owns one `whisper_context*`,
one `whisper_vad_context*`, a float conversion buffer, a carry buffer, and
explicit `closed_` state. The constructor loads both models exactly once.
`pushVad()` appends each 320-sample frame, regroups the stream into 512-sample
Silero windows, calls `whisper_vad_detect_speech_no_reset`, and returns zero or
more newly available probabilities while retaining remaining carry samples.
`reset()` clears the carry and recurrent VAD state; `close()` frees each context
once.

`decode()` copies the input `Int16Array` before launching `Napi::AsyncWorker`, calls greedy `whisper_full` with translation off, automatic language, timestamps off, and context prompt, then resolves the promise on the JavaScript thread. Protect the context with one mutex so the gateway pool never invokes two decodes concurrently on one handle.

`warmup()` runs one bounded silent encoder/decode operation and resolves only
when lazy CPU/GPU allocations are complete. The server does not advertise
readiness before every pooled handle has warmed successfully.

- [ ] **Step 6: Build native and run the pinned JFK smoke test**

Run:

```bash
npm run build:native --workspace @voice/native-whisper-addon
npm test --workspace @voice/native-whisper-addon
```

Expected: loader tests PASS. With `VOICE_MODEL_PATH` and `VOICE_VAD_MODEL_PATH` set, the optional smoke case decodes `apps/web/tests/fixtures/jfk.wav` and contains `Kennedy`; without those variables it reports a skipped smoke test, not a false pass.

- [ ] **Step 7: Commit**

```bash
git add package-lock.json packages/native-whisper-addon
git commit -m "feat: add persistent native whisper runtime"
```

---

### Task 9: Connect the native runtime pool to the server

**Files:**
- Create: `apps/transcription-server/src/nativeRuntime.ts`
- Create: `apps/transcription-server/src/runtimePool.ts`
- Modify: `apps/transcription-server/src/main.ts`
- Test: `apps/transcription-server/test/runtimePool.test.ts`
- Test: `apps/transcription-server/test/nativeSmoke.test.ts`
- Modify: `apps/transcription-server/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write red pool tests**

Inject fake native handles. Assert the configured pool creates and warms exactly
`capacity` handles at startup, reserves one per session, serializes
provisional/final decode per handle, releases on close, rejects the fifth
reservation when capacity is four, replaces a timed-out handle before
readmission, and destroys all handles once on shutdown.

- [ ] **Step 2: Confirm red**

Run: `npx vitest run test/runtimePool.test.ts` from the server workspace.

Expected: FAIL because `RuntimePool` is missing.

- [ ] **Step 3: Implement the pool and adapter**

`RuntimePool` receives `createHandle()`, integer capacity, and
`decodeTimeoutMs` (default `30_000`). Each lease exposes one
`StreamingRuntimeSession`; it sends frames to native `pushVad()`, feeds returned
probabilities to the pure TypeScript `VadGate`, stores bounded utterance PCM,
and forwards decode windows and prompts to the handle. Race every decode against
the timeout. Release resets a healthy handle before returning it to the idle
queue. A failed or timed-out handle is closed, replaced, and warmed before new
admission.

- [ ] **Step 4: Wire production startup**

Load `@voice/native-whisper-addon` in `main.ts`, reject `.en` model paths with `VOICE_MODEL_PATH must reference a multilingual model`, create four handles by default, and pass the pool-backed runtime to the gateway. Add signal handlers that stop admission, close sockets, await active releases for at most 10 seconds, then close handles and HTTP server.

Add server script `test:native: "vitest run test/nativeSmoke.test.ts"` and a
native smoke test gated by `VOICE_MODEL_PATH`/`VOICE_VAD_MODEL_PATH`. The test
fails, rather than skips, when `VOICE_REQUIRE_NATIVE_TEST=1` is set and either
model is unavailable.

- [ ] **Step 5: Verify server tests with fake native handles**

Run: `npm test --workspace @voice/transcription-server && npm run typecheck --workspace @voice/transcription-server`

Expected: all server tests PASS without loading the real addon.

- [ ] **Step 6: Commit**

```bash
git add package-lock.json apps/transcription-server
git commit -m "feat: pool persistent whisper decoders"
```

---

### Task 10: Add GPU image, model provisioning, and benchmark gates

**Files:**
- Create: `apps/transcription-server/Dockerfile.cuda`
- Create: `apps/transcription-server/scripts/fetch-server-models.mjs`
- Create: `apps/transcription-server/scripts/benchmark.mjs`
- Create: `apps/transcription-server/test/fixtures/manifest.json`
- Test: `apps/transcription-server/test/modelProvisioning.test.ts`
- Modify: `apps/transcription-server/package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Add checksum-verified server model provisioning tests**

Factor download/hash logic behind injected `fetch` and filesystem seams. Test valid cache reuse, checksum mismatch deletion, interrupted download cleanup, and rejection of `.en` names. Server weights go to `apps/transcription-server/models/`, which is gitignored.

- [ ] **Step 2: Implement the fetcher and scripts**

Provide explicit model entries for multilingual `small`
(`ggml-small.bin`) and `medium` (`ggml-medium.bin`) plus
`ggml-silero-v6.2.0.bin`, each with source URL and pinned SHA-256. The script
requires `--model small|medium`; it never downloads both Whisper tiers
implicitly.

Add scripts:

```json
"fetch-models": "node scripts/fetch-server-models.mjs",
"benchmark": "node scripts/benchmark.mjs",
"build:cuda-image": "docker build -f Dockerfile.cuda -t voice-transcription-server:cuda ../.."
```

- [ ] **Step 3: Build a pinned CUDA production image**

Use a digest-pinned NVIDIA CUDA runtime/build base. Install Node and CMake in the build stage, compile whisper.cpp/N-API with CUDA enabled, run TypeScript builds, and copy only production node modules, JS, addon binary, and server entrypoint to the runtime stage. Run as a non-root user, expose the configured port, and add an HTTP `/health/ready` check that is healthy only after every model handle is warm.

- [ ] **Step 4: Implement benchmark output and hard gates**

The benchmark opens four simultaneous WebSocket sessions and feeds labeled fixture PCM in real time. Emit one JSON line:

```json
{"firstPartialP95Ms":0,"refreshP95Ms":0,"finalAfterSilenceP95Ms":0,"realTimeFactor":0,"sessions":4,"model":"small","werByLanguage":{},"cerByLanguage":{}}
```

Exit nonzero unless first partial is `<=1500`, refresh is `<=1000`, final-after-silence is `<=1500`, and real-time factor is `<0.5`. Compare quantized versus unquantized reports and reject aggregate WER/CER regression above one absolute point or any language above two points.

- [ ] **Step 5: Run model comparison on the reference GPU**

Run the CUDA image once with multilingual `small`, then `medium`, using the same four-session fixture set. Save timestamped raw JSON under gitignored `apps/transcription-server/benchmark-results/`. Select the more accurate model only if it passes every latency gate; otherwise select the fastest passing tier and record the evidence in the server README.

- [ ] **Step 6: Commit reproducible configuration, not weights/results**

```bash
git add .gitignore apps/transcription-server
git commit -m "build: add GPU whisper deployment benchmark"
```

---

### Task 11: Update root build order and documentation

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Create: `packages/streaming-protocol/README.md`
- Create: `packages/remote-whisper-engine/README.md`
- Create: `apps/transcription-server/README.md`
- Create: `packages/native-whisper-addon/README.md`
- Modify: generated `dist/` trees for new TypeScript packages

- [ ] **Step 1: Make clean-checkout build order explicit**

Replace the root generic build script with explicit package order: contracts, streaming protocol, local engine, remote engine, native-addon TypeScript loader, transcription server, then web. Keep test/typecheck commands building first. This prevents a clean checkout from depending on stale generated declarations.

- [ ] **Step 2: Rewrite architecture and privacy documentation**

Document two explicit modes:

```text
Online real-time: microphone -> WSS -> native GPU Whisper -> revisions -> browser
Offline local: microphone -> browser Worker -> WASM Whisper -> final-only browser text
```

Document required environment variables, loopback development, model fetch/build commands, token/origin requirements, no-persistence policy, foreground-only iPhone Safari scope, and that Siri/App Intents remains a future entry point.

- [ ] **Step 3: Document protocol and native lifecycle invariants**

Record the 656-byte frame layout, one-session-per-socket rule, ACK semantics, model-handle serialization, no `.en` policy, fake-runtime test path, native build command, and GPU benchmark thresholds in the package READMEs.

- [ ] **Step 4: Build all generated TypeScript outputs**

Run: `npm run build`

Expected: every workspace builds in the explicit order and new `dist/` outputs are generated.

- [ ] **Step 5: Commit**

```bash
git add package.json README.md CLAUDE.md apps/transcription-server/README.md packages/*/README.md packages/*/dist apps/transcription-server/dist
git commit -m "docs: describe real-time whisper deployment"
```

---

### Task 12: Final verification and branch handoff

**Files:**
- Modify only if a failing verification exposes a defect; return to the owning task's test first.

- [ ] **Step 1: Verify repository and submodule state**

Run:

```bash
git status --short
git submodule status
git diff --check
```

Expected: no unstaged changes, pinned whisper.cpp submodule initialized, and no whitespace errors.

- [ ] **Step 2: Run the complete deterministic matrix**

Run:

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run test:e2e --workspace @voice/web
```

Expected: all commands exit 0. Ordinary verification must not invoke CMake, load a native binary, or require a GPU.

- [ ] **Step 3: Run real native smoke verification**

Run:

```bash
npm run build:native --workspace @voice/native-whisper-addon
npm run fetch-models --workspace @voice/transcription-server -- --model small
```

Then on PowerShell run:

```powershell
$env:VOICE_MODEL_PATH = (Resolve-Path 'apps/transcription-server/models/ggml-small.bin').Path
$env:VOICE_VAD_MODEL_PATH = (Resolve-Path 'apps/transcription-server/models/ggml-silero-v6.2.0.bin').Path
$env:VOICE_REQUIRE_NATIVE_TEST = '1'
npm run test:native --workspace @voice/transcription-server
```

Expected: native addon loads the model once, Silero detects the fixture speech, and the final JFK transcript contains `Kennedy`.

- [ ] **Step 4: Run the four-session GPU acceptance benchmark**

Run: `npm run benchmark --workspace @voice/transcription-server`

Expected: command exits 0 and the JSON record satisfies every latency/RTF/accuracy gate in the specification.

- [ ] **Step 5: Inspect the full branch diff**

Run: `git diff --stat recovery/migration/whisper-cpp-vad...HEAD` and `git log --oneline recovery/migration/whisper-cpp-vad..HEAD`.

Expected: only the approved spec/plan and streaming-service implementation are present; `vendor/whisper.cpp` has no local modifications.

- [ ] **Step 6: Use the finishing-development-branch workflow**

Present merge, push/PR, keep, and cleanup choices only after all applicable checks are freshly green. Do not claim GPU acceptance when the benchmark was skipped or run on non-reference hardware.
