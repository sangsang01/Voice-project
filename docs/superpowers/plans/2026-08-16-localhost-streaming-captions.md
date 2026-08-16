# Localhost Streaming Captions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream live multilingual captions on this PC by sending 20 ms microphone frames to a warm native whisper.cpp process over `ws://127.0.0.1`, updating one provisional line while the user talks and locking a final line after silence.

**Architecture:** Add a versioned binary/JSON protocol, a browser `RemoteWhisperEngine` that keeps the existing `TranscriptionEngine` contract, and a localhost Node gateway whose session scheduler runs rolling 750 ms decodes. Native whisper.cpp and Silero load once at process start and stay loaded until the process exits. The current WASM engine remains an explicit Offline local fallback.

**Tech Stack:** TypeScript 6, Node.js, `ws` 8, Vitest 4, React 19, Playwright, C++17, N-API, cmake-js, pinned whisper.cpp v1.9.2, Silero VAD v6.2.0. GPU is optional at native compile time; CI never requires CMake or a GPU.

**Spec:** `docs/superpowers/specs/2026-08-14-localhost-streaming-captions-design.md`

---

## Global constraints

- Keep `SessionRequest` and `PcmFrame` unchanged: 16 kHz mono `pcm_s16le`, 320 samples, 20 ms.
- Preserve `segment.upsert` revision semantics: one live segment id while talking; finals are immutable.
- Multilingual models only. Reject any model path whose file name contains `.en`.
- Do not patch `vendor/whisper.cpp`. Native glue lives in `packages/native-whisper-addon/`.
- Ordinary `npm test` / `npm run typecheck` must pass without a GPU, CMake, or native binary. Inject fake sockets and fake runtimes.
- Bind and connect on loopback only. No auth tokens, no `wss:`, no cloud image in this plan.
- Whisper loads once per server process. Start/Stop in the UI must not reload weights. There is no idle unload.
- One active listen session. A second `session.start` is `RESOURCE_EXHAUSTED`.
- Root `.gitignore` contains `dist/`. Existing engine `dist/` trees are already tracked; new packages must `git add -f <path>/dist` so a clean checkout can typecheck.
- Every task is red-green-refactor and ends in one focused commit.
- Commit with a single-line `git commit -m "..."` message (PowerShell-safe). Do not use `git commit --amend` or `--no-verify`.

## File structure

### New workspaces

| Path | Responsibility |
| --- | --- |
| `packages/streaming-protocol/` | 656-byte PCM codec, JSON control/event types, loopback URL rule |
| `packages/remote-whisper-engine/` | Browser WebSocket `TranscriptionEngine` |
| `apps/transcription-server/` | Loopback gateway, rolling scheduler, warm runtime adapter |
| `packages/native-whisper-addon/` | Persistent N-API whisper.cpp + Silero; JS loader used by the server |

### Existing files modified

| Path | Change |
| --- | --- |
| `package.json` / `package-lock.json` | Workspace scripts and deterministic build order |
| `.gitignore` | Ignore `apps/transcription-server/models/` and benchmark results |
| `apps/web/package.json` | Depend on `@voice/remote-whisper-engine` |
| `apps/web/src/vite-env.d.ts` | `VITE_TRANSCRIPTION_WS_URL` |
| `apps/web/src/features/transcription/sessionController.ts` | Provider-neutral backpressure copy; `resetEngine()` |
| `apps/web/src/features/transcription/TranscriptionAdapter.tsx` | Live default, Offline control, provisional markup |
| `apps/web/src/app.css` | Provisional caption styling |
| `apps/web/src/features/transcription/TranscriptionAdapter.test.tsx` | Mode + provisional tests |
| `apps/web/tests/e2e/transcription.spec.ts` | Live revision e2e |
| `README.md`, `CLAUDE.md` | Two-process live path vs offline WASM |

---

### Task 1: Add the binary PCM protocol package

**Files:**
- Create: `packages/streaming-protocol/package.json`
- Create: `packages/streaming-protocol/tsconfig.json`
- Create: `packages/streaming-protocol/src/pcm.ts`
- Create: `packages/streaming-protocol/src/index.ts`
- Test: `packages/streaming-protocol/test/pcm.test.ts`

- [ ] **Step 1: Create the workspace manifest and TypeScript config**

`packages/streaming-protocol/package.json`:

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
  "dependencies": {
    "@voice/transcription-contracts": "0.0.0"
  },
  "devDependencies": {
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

`packages/streaming-protocol/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "noEmit": false
  },
  "include": ["src"]
}
```

Run `npm install` from the repository root so the workspace is linked.

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
    const decoded = decodePcmMessage(encoded);
    expect(decoded.sequence).toBe(7);
    expect(decoded.startMs).toBe(140);
    expect(Array.from(decoded.samples)).toEqual(Array.from(samples));
  });

  it("rejects the wrong byte length", () => {
    expect(() => decodePcmMessage(new ArrayBuffer(655))).toThrow(/656/);
  });

  it("rejects an unsupported protocol version", () => {
    const bytes = new Uint8Array(656);
    bytes[0] = 2;
    bytes[1] = 1;
    expect(() => decodePcmMessage(bytes.buffer)).toThrow(/version/);
  });

  it("rejects nonzero reserved bytes", () => {
    const bytes = new Uint8Array(656);
    bytes[0] = 1;
    bytes[1] = 1;
    bytes[2] = 1;
    expect(() => decodePcmMessage(bytes.buffer)).toThrow(/reserved/);
  });
});
```

- [ ] **Step 3: Run the focused test and confirm red**

Run from `packages/streaming-protocol`:

```bash
npx vitest run test/pcm.test.ts
```

Expected: FAIL because `../src/index.js` does not exist.

- [ ] **Step 4: Implement the codec**

`packages/streaming-protocol/src/pcm.ts`:

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
  if (buffer.byteLength !== PCM_MESSAGE_BYTES) {
    throw new RangeError("PCM message must be 656 bytes");
  }
  const view = new DataView(buffer);
  if (view.getUint8(0) !== PCM_PROTOCOL_VERSION) {
    throw new TypeError("unsupported PCM protocol version");
  }
  if (view.getUint8(1) !== PCM_MESSAGE_TYPE) {
    throw new TypeError("unsupported binary message type");
  }
  if (view.getUint16(2, true) !== 0) {
    throw new TypeError("reserved PCM header bytes must be zero");
  }
  const samples = new Int16Array(320);
  for (let index = 0; index < 320; index += 1) {
    samples[index] = view.getInt16(PCM_HEADER_BYTES + index * 2, true);
  }
  return { sequence: view.getUint32(4, true), startMs: view.getFloat64(8, true), samples };
}
```

`packages/streaming-protocol/src/index.ts`:

```ts
export * from "./pcm.js";
```

- [ ] **Step 5: Verify green and build**

```bash
npm test --workspace @voice/streaming-protocol
npm run build --workspace @voice/streaming-protocol
```

Expected: codec tests PASS and `packages/streaming-protocol/dist/` is generated.

- [ ] **Step 6: Commit**

```bash
git add package-lock.json packages/streaming-protocol
git add -f packages/streaming-protocol/dist
git commit -m "feat: add streaming PCM wire codec"
```

---

### Task 2: Add control messages, loopback URL rule, and validators

**Files:**
- Create: `packages/streaming-protocol/src/messages.ts`
- Create: `packages/streaming-protocol/src/validation.ts`
- Create: `packages/streaming-protocol/src/loopback.ts`
- Modify: `packages/streaming-protocol/src/index.ts`
- Test: `packages/streaming-protocol/test/messages.test.ts`
- Test: `packages/streaming-protocol/test/loopback.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/streaming-protocol/test/messages.test.ts`:

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

  it("accepts session.accepted with model and backend", () => {
    expect(validateServerMessage({
      type: "session.accepted",
      sessionId: "session-1",
      model: "small",
      backend: "cpu",
    })).toMatchObject({ backend: "cpu" });
  });

  it("rejects unknown controls and incomplete engine events", () => {
    expect(() => validateClientControl({ type: "session.pause" })).toThrow();
    expect(() => validateServerMessage({ type: "engine.event", event: { type: "state" } })).toThrow();
    expect(() => validateServerMessage({
      type: "session.accepted",
      sessionId: "session-1",
      model: "small",
      backend: "tpu",
    })).toThrow();
  });
});
```

`packages/streaming-protocol/test/loopback.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertLoopbackWebSocketUrl } from "../src/index.js";

describe("assertLoopbackWebSocketUrl", () => {
  it("accepts loopback ws URLs", () => {
    expect(() => assertLoopbackWebSocketUrl("ws://127.0.0.1:8787")).not.toThrow();
    expect(() => assertLoopbackWebSocketUrl("ws://localhost:8787")).not.toThrow();
    expect(() => assertLoopbackWebSocketUrl("ws://[::1]:8787")).not.toThrow();
  });

  it("rejects non-loopback and non-ws URLs", () => {
    expect(() => assertLoopbackWebSocketUrl("ws://192.168.1.8:8787")).toThrow(/loopback/);
    expect(() => assertLoopbackWebSocketUrl("ws://0.0.0.0:8787")).toThrow(/loopback/);
    expect(() => assertLoopbackWebSocketUrl("http://127.0.0.1:8787")).toThrow(/ws/);
  });
});
```

- [ ] **Step 2: Confirm red**

```bash
npx vitest run test/messages.test.ts test/loopback.test.ts
```

Run from `packages/streaming-protocol`. Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Implement types, validators, and the loopback helper**

`packages/streaming-protocol/src/messages.ts`:

```ts
import type { EngineEvent, SessionRequest } from "@voice/transcription-contracts";

export type NativeBackend = "cpu" | "cuda" | "vulkan" | "metal";

export type ClientControl =
  | { type: "session.start"; protocol: 1; request: SessionRequest }
  | { type: "session.stop"; sessionId: string }
  | { type: "session.cancel"; sessionId: string };

export type ServerMessage =
  | { type: "session.accepted"; sessionId: string; model: string; backend: NativeBackend }
  | { type: "audio.ack"; sessionId: string; throughSequence: number }
  | { type: "engine.event"; event: EngineEvent };
```

`packages/streaming-protocol/src/loopback.ts`:

```ts
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function assertLoopbackWebSocketUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError("transcription endpoint must be a valid URL");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new TypeError("transcription endpoint must use the ws: protocol");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new TypeError("transcription endpoint must be a loopback address");
  }
  return parsed;
}

export function assertLoopbackBindHost(host: string): void {
  const normalized = host.replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw new TypeError("transcription server must bind to a loopback address");
  }
}
```

`packages/streaming-protocol/src/validation.ts` must export:

```ts
export function validateClientControl(value: unknown): ClientControl;
export function validateServerMessage(value: unknown): ServerMessage;
export function parseJsonMessage(text: string): unknown;
```

Implement them without a new schema library:

- `parseJsonMessage` wraps `JSON.parse` and throws `TypeError("message must be valid JSON")`.
- `validateClientControl` accepts only the three discriminants. For `session.start`, require `protocol === 1` and run `validateSessionRequest(request)` from `@voice/transcription-contracts`. For stop/cancel, require a nonempty `sessionId` string.
- `validateServerMessage` accepts `session.accepted` with nonempty `sessionId`/`model` and `backend` in `cpu|cuda|vulkan|metal`; `audio.ack` with nonempty `sessionId` and a finite nonnegative integer `throughSequence`; `engine.event` whose nested `event` has a valid `EngineEvent` discriminant (`state`, `segment.upsert`, `segment.remove`, `warning`, `error`) plus the required fields already used in `packages/transcription-contracts/src/events.ts` (`sessionId`, `sequence`, and the per-type payload). Reject unknown top-level `type` values.

Export everything from `src/index.ts`:

```ts
export * from "./pcm.js";
export * from "./messages.js";
export * from "./validation.js";
export * from "./loopback.js";
```

- [ ] **Step 4: Verify green and rebuild**

```bash
npm test --workspace @voice/streaming-protocol
npm run build --workspace @voice/streaming-protocol
```

Expected: all protocol tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/streaming-protocol
git add -f packages/streaming-protocol/dist
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
- Test: `packages/remote-whisper-engine/test/fakeSocket.ts`
- Test: `packages/remote-whisper-engine/test/RemoteWhisperEngine.test.ts`
- Test: `packages/remote-whisper-engine/test/contract.test.ts`

- [ ] **Step 1: Create the workspace**

`packages/remote-whisper-engine/package.json`:

```json
{
  "name": "@voice/remote-whisper-engine",
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
  "dependencies": {
    "@voice/streaming-protocol": "0.0.0",
    "@voice/transcription-contracts": "0.0.0"
  },
  "devDependencies": {
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

Use the same `tsconfig.json` shape as `packages/streaming-protocol/tsconfig.json`. Run `npm install` from the root.

- [ ] **Step 2: Define the injectable socket seam**

`packages/remote-whisper-engine/src/socket.ts`:

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

export const browserSocketFactory: SocketFactory = (url, protocols) =>
  new WebSocket(url, [...protocols]);
```

- [ ] **Step 3: Write the fake socket and red lifecycle tests**

`packages/remote-whisper-engine/test/fakeSocket.ts`:

```ts
import type { SocketLike } from "../src/socket.js";

type Handler = (event: Event) => void;

export class FakeSocket implements SocketLike {
  public readyState = 0;
  public bufferedAmount = 0;
  public binaryType: BinaryType = "arraybuffer";
  public readonly sent: Array<string | ArrayBuffer> = [];
  public protocols: readonly string[] = [];
  private readonly listeners = new Map<string, Set<Handler>>();

  public constructor(public readonly url: string, protocols: readonly string[] = []) {
    this.protocols = protocols;
  }

  public send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  public close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.emit("close", new CloseEvent("close", { code, reason }));
  }

  public addEventListener(type: string, listener: Handler): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  public removeEventListener(type: string, listener: Handler): void {
    this.listeners.get(type)?.delete(listener);
  }

  public open(): void {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  public emitJson(value: unknown): void {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  public sentJson(): unknown[] {
    return this.sent.filter((value): value is string => typeof value === "string").map((value) => JSON.parse(value));
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
```

If the Vitest/jsdom environment lacks `CloseEvent`/`MessageEvent`, construct plain objects with the same `type`, `code`, `reason`, and `data` fields and cast them as the DOM types. Do not skip the tests.

`packages/remote-whisper-engine/test/RemoteWhisperEngine.test.ts` (core assertions):

```ts
import { describe, expect, it } from "vitest";
import { RemoteWhisperEngine } from "../src/index.js";
import { FakeSocket } from "./fakeSocket.js";

const request = {
  sessionId: "session-1",
  candidateLanguages: ["en-US"],
  mode: "transcribe",
  audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
} as const;

describe("RemoteWhisperEngine lifecycle", () => {
  it("inspects loopback endpoints as available", async () => {
    const engine = new RemoteWhisperEngine({ endpoint: "ws://127.0.0.1:8787", socketFactory: () => new FakeSocket("ws://127.0.0.1:8787") });
    await expect(engine.inspect()).resolves.toEqual({ available: true });
  });

  it("inspects a LAN URL as unavailable", async () => {
    const engine = new RemoteWhisperEngine({ endpoint: "ws://192.168.1.8:8787", socketFactory: () => new FakeSocket("ws://192.168.1.8:8787") });
    const inspection = await engine.inspect();
    expect(inspection.available).toBe(false);
    expect(inspection.reason).toMatch(/loopback/);
  });

  it("opens a session only after session.accepted", async () => {
    const sockets: FakeSocket[] = [];
    const engine = new RemoteWhisperEngine({
      endpoint: "ws://127.0.0.1:8787",
      socketFactory: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    await engine.prepare(request);
    const opening = engine.open(request);
    sockets[0]!.emitJson({ type: "session.accepted", sessionId: request.sessionId, model: "small", backend: "cpu" });
    const session = await opening;
    expect(sockets[0]!.protocols).toContain("voice-transcription.v1");
    expect(sockets[0]!.sentJson()).toContainEqual({ type: "session.start", protocol: 1, request });
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));
    await session.cancel();
    expect(sockets[0]!.sentJson()).toContainEqual({ type: "session.cancel", sessionId: request.sessionId });
    await engine.dispose();
  });

  it("emits one fatal UNAVAILABLE and stopped when the socket closes", async () => {
    const sockets: FakeSocket[] = [];
    const engine = new RemoteWhisperEngine({
      endpoint: "ws://127.0.0.1:8787",
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    await engine.prepare(request);
    const opening = engine.open(request);
    sockets[0]!.emitJson({ type: "session.accepted", sessionId: request.sessionId, model: "small", backend: "cpu" });
    const session = await opening;
    const events: Array<{ type: string; code?: string; state?: string }> = [];
    session.subscribe((event) => events.push(event as { type: string; code?: string; state?: string }));
    sockets[0]!.close(1006, "lost");
    expect(events.some((event) => event.type === "error" && event.code === "UNAVAILABLE")).toBe(true);
    expect(events.some((event) => event.type === "state" && event.state === "stopped")).toBe(true);
    await engine.dispose();
  });
});
```

Also assert `open()` before `prepare()` rejects.

- [ ] **Step 4: Confirm red**

```bash
npm test --workspace @voice/remote-whisper-engine
```

Expected: FAIL because `RemoteWhisperEngine` is missing.

- [ ] **Step 5: Implement lifecycle**

Public options:

```ts
export interface RemoteWhisperEngineOptions {
  endpoint: string;
  socketFactory?: SocketFactory;
  maxUnacknowledgedFrames?: number;
}
```

Default `socketFactory` is `browserSocketFactory`. Default `maxUnacknowledgedFrames` is `250`.

Behavior:

- `inspect()` runs `assertLoopbackWebSocketUrl(endpoint)`. On success return `{ available: true }`. On throw return `{ available: false, reason: error.message }`.
- `prepare(request)` validates the request, opens one socket to `endpoint` with subprotocol `voice-transcription.v1`, and resolves on `open`. Connection failure becomes a thrown `Error` whose message mentions the local Whisper server is unavailable.
- `open(request)` requires a prepared socket. Send `{ type: "session.start", protocol: 1, request }`. Resolve only after a matching `session.accepted`. Replay `listening` to the first subscriber if the server already sent it.
- Validate every inbound JSON message with `validateServerMessage`. Forward only `engine.event` values whose `sessionId` matches.
- `stop()` / `cancel()` send the matching control once, then wait for `stopped` or socket close. They are idempotent.
- `dispose()` cancels an active session and closes the socket exactly once.
- There is no `tokenProvider` and no `access_token` query parameter.

- [ ] **Step 6: Add the shared contract suite**

`packages/remote-whisper-engine/test/contract.test.ts`:

Drive the fake socket automatically: on `session.start`, emit `session.accepted` with `backend: "cpu"`; ACK each PCM binary with `throughSequence` equal to that frame sequence; on `session.stop`, emit `draining`, one final `segment.upsert`, then `stopped`. Use `describeEngineContract("remote whisper", createEngine, fixture)` from `@voice/transcription-contracts/testing`. Use `framesBeforeStop: 1`.

- [ ] **Step 7: Verify green**

```bash
npm test --workspace @voice/remote-whisper-engine
npm run typecheck --workspace @voice/remote-whisper-engine
npm run build --workspace @voice/remote-whisper-engine
```

Expected: lifecycle and contract tests PASS.

- [ ] **Step 8: Commit**

```bash
git add package-lock.json packages/remote-whisper-engine
git add -f packages/remote-whisper-engine/dist
git commit -m "feat: add remote whisper engine lifecycle"
```

---

### Task 4: Bound remote audio backpressure

**Files:**
- Modify: `packages/remote-whisper-engine/src/RemoteWhisperEngine.ts`
- Test: `packages/remote-whisper-engine/test/backpressure.test.ts`

- [ ] **Step 1: Write red backpressure tests**

With `maxUnacknowledgedFrames: 2`, assert:

- first two `push()` calls return `{ accepted: true }`
- the third returns `{ accepted: false, reason: "backpressure" }`
- `audio.ack` with `throughSequence: 0` permits one more frame
- duplicate or regressing ACKs do not add credit
- ACK beyond the highest sent sequence is a fatal protocol `error` event
- `socket.bufferedAmount > 1_048_576` rejects with backpressure
- after `stop()`, further `push()` returns backpressure

Encode accepted frames with `encodePcmMessage` and assert `socket.sent` contains an `ArrayBuffer` of 656 bytes.

- [ ] **Step 2: Confirm red**

```bash
npx vitest run test/backpressure.test.ts
```

Run from `packages/remote-whisper-engine`. Expected: FAIL because pushes are not credit-bounded.

- [ ] **Step 3: Implement bounded unacknowledged tracking**

Maintain `highestSentSequence` and a `Set<number>` of outstanding sequences. Accept a frame only when `outstanding.size < maxUnacknowledgedFrames`, the session is not terminal, and `socket.bufferedAmount <= 1_048_576`. On a valid ACK, delete every outstanding sequence `<= throughSequence`. Call `encodePcmMessage(frame)` only after those checks.

- [ ] **Step 4: Verify green**

```bash
npm test --workspace @voice/remote-whisper-engine
```

Expected: all remote-engine tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/remote-whisper-engine
git add -f packages/remote-whisper-engine/dist
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

- [ ] **Step 1: Create the server workspace**

`apps/transcription-server/package.json`:

```json
{
  "name": "@voice/transcription-server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/main.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit --pretty false",
    "dev": "node dist/main.js"
  },
  "dependencies": {
    "@voice/streaming-protocol": "0.0.0",
    "@voice/transcription-contracts": "0.0.0",
    "ws": "8.18.3"
  },
  "devDependencies": {
    "@types/ws": "8.18.1",
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

If `ws@8.18.3` / `@types/ws@8.18.1` are unpublished, pin the newest 8.x versions `npm install` resolves and keep them identical in this file and the lockfile. Use the same NodeNext `tsconfig` as the protocol package, `rootDir: "src"`, `outDir: "dist"`. Run `npm install` from the root.

- [ ] **Step 2: Port VAD and language mapping**

Copy `packages/local-whisper-engine/src/worker/vadGate.ts` to `apps/transcription-server/src/vadGate.ts` unchanged.

Copy `packages/local-whisper-engine/src/segmentation/languageMap.ts` to `apps/transcription-server/src/languageMap.ts` unchanged.

Copy `packages/local-whisper-engine/test/vadGate.test.ts` to `apps/transcription-server/test/vadGate.test.ts`, changing the import to `../src/vadGate.js`.

Copy `packages/local-whisper-engine/test/languageMap.test.ts` to `apps/transcription-server/test/languageMap.test.ts`, changing the import to `../src/languageMap.js`.

Do not import `@voice/local-whisper-engine` from the server (that package’s entry pulls browser worker types).

- [ ] **Step 3: Define the native-independent runtime seam**

`apps/transcription-server/src/runtime.ts`:

```ts
import type { PcmFrame, SessionRequest } from "@voice/transcription-contracts";
import type { NativeBackend } from "@voice/streaming-protocol";

export interface VadUpdate {
  speechStarted: boolean;
  speechEnded: boolean;
  maxDuration: boolean;
}

export interface DecodeResult {
  text: string;
  language: string;
  languageProbability: number;
  startMs: number;
  endMs: number;
}

export interface StreamingRuntimeSession {
  push(frame: PcmFrame): VadUpdate;
  decode(kind: "provisional" | "final", audio: Int16Array, prompt: string): Promise<DecodeResult>;
  close(): Promise<void>;
}

export interface StreamingRuntime {
  readonly modelName: string;
  readonly backend: NativeBackend;
  readonly loadCount: number;
  ready(): Promise<void>;
  open(request: SessionRequest): Promise<StreamingRuntimeSession>;
}
```

`loadCount` increments only when weights are loaded, never on `open()`.

- [ ] **Step 4: Write red scheduler tests with fake timers**

`apps/transcription-server/test/sessionScheduler.test.ts` must cover all of the following with `vi.useFakeTimers()`:

1. Speech start does not decode before 750 ms.
2. The first tick emits `segment.upsert` revision 0, `isFinal: false`, language `und`, id `${sessionId}:0`.
3. A second tick emits revision 1 with the same id.
4. If `decode()` is pending, a third tick does not start another decode; after the pending promise resolves, exactly one newest-window decode runs.
5. Speech end runs exactly one `final` decode, emits `isFinal: true` with mapped language, and ignores later provisional ticks for that id.
6. `stop()` while speaking emits `draining`, one final, then `stopped`.
7. `cancel()` while speaking emits `stopped` and no segment.
8. `maxDuration: true` finalizes the current id and the next speech uses ordinal 1 / a new id.
9. Three consecutive provisional decodes slower than their audio window emit `warning` with `DEGRADED_PERFORMANCE`.

Use this fake session:

```ts
class FakeRuntimeSession {
  public decodes: Array<{ kind: "provisional" | "final"; samples: number }> = [];
  public nextVad: VadUpdate = { speechStarted: false, speechEnded: false, maxDuration: false };
  public decodeImpl?: () => Promise<DecodeResult>;
  public push(): VadUpdate {
    return this.nextVad;
  }
  public async decode(kind: "provisional" | "final", audio: Int16Array): Promise<DecodeResult> {
    this.decodes.push({ kind, samples: audio.length });
    if (this.decodeImpl) return this.decodeImpl();
    return { text: kind === "final" ? "hello how are you" : "hello", language: "en", languageProbability: 1, startMs: 0, endMs: 800 };
  }
  public close(): Promise<void> {
    return Promise.resolve();
  }
}
```

Constructor options the tests pass:

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

Defaults: `decodeIntervalMs: 750`, `maxWindowMs: 8000`, `overlapMs: 500`.

- [ ] **Step 5: Confirm red**

```bash
npm test --workspace @voice/transcription-server
```

Expected: FAIL because `SessionScheduler` is missing.

- [ ] **Step 6: Implement `SessionScheduler`**

`apps/transcription-server/src/sessionScheduler.ts`:

- Buffer accepted PCM in chronological order. Retain the active utterance plus `overlapMs`.
- `push(frame)` calls `runtime.push(frame)`, stores samples, and on `speechStarted` starts the interval timer. On `speechEnded` or `maxDuration`, request a final decode (finals preempt provisionals).
- Serialize decodes. Replace any pending provisional with the newest window. A queued final cancels pending provisionals.
- Window = last `maxWindowMs` of the current utterance, plus `overlapMs` of prior audio when available, plus the last stable prompt string (empty until a final exists).
- Segment id `${sessionId}:${ordinal}`. Increment `revision` per emitted hypothesis. Provisionals use `{ tag: "und" }`. Finals use `mapDetectedLanguage`.
- Emit `state: listening` from `start()`.
- `stop()` emits `draining`, flushes pending speech as final if any, emits `stopped`.
- `cancel()` drops the buffer, emits `stopped`, and does not call `decode`.
- Track consecutive slower-than-realtime provisionals (`elapsedMs > audioDurationMs`). On the third, emit `DEGRADED_PERFORMANCE`.
- Assign monotonically increasing `sequence` on every `EngineEvent`.

- [ ] **Step 7: Verify green**

```bash
npm test --workspace @voice/transcription-server
npm run typecheck --workspace @voice/transcription-server
```

Expected: VAD, language, and scheduler tests PASS without a native binary.

- [ ] **Step 8: Commit**

```bash
git add package-lock.json apps/transcription-server
git add -f apps/transcription-server/dist
git commit -m "feat: schedule rolling transcript revisions"
```

---

### Task 6: Add localhost WebSocket admission and gateway

**Files:**
- Create: `apps/transcription-server/src/admission.ts`
- Create: `apps/transcription-server/src/metrics.ts`
- Create: `apps/transcription-server/src/gateway.ts`
- Create: `apps/transcription-server/src/main.ts`
- Test: `apps/transcription-server/test/gateway.test.ts`
- Test: `apps/transcription-server/test/metrics.test.ts`
- Test: `apps/transcription-server/test/warmRuntime.test.ts`

- [ ] **Step 1: Write red gateway, metrics, and warm-runtime tests**

Gateway tests use `ws` against `host: "127.0.0.1"` and `port: 0`, with an injected fake `StreamingRuntime`. Cover:

- `session.start` returns `session.accepted` with `model` and `backend`
- binary 656-byte PCM is decoded and answered with `audio.ack`
- a second `session.start` on the same socket, or a second concurrent socket, receives a fatal `RESOURCE_EXHAUSTED` (`capacity: 1`)
- `session.stop` / `session.cancel` close the listen and release capacity so a later socket can start
- malformed JSON, malformed PCM, and a sequence gap produce the contract error codes (`INVALID_AUDIO` or `AUDIO_GAP`) then close code `4000`
- `Origin` not in `allowedOrigins` is rejected at upgrade
- `createTranscriptionGateway({ host: "0.0.0.0" })` throws `/loopback/`
- `prepare`/`ready` wait: if `runtime.ready()` is pending, `session.start` is not accepted until it resolves
- after close, `runtime.open` call count can increase, but `runtime.loadCount` stays `1`

Warm-runtime test (`test/warmRuntime.test.ts`):

```ts
it("loads weights once across two sessions", async () => {
  const runtime = new FakeRuntime();
  await runtime.ready();
  await (await runtime.open(request)).close();
  await (await runtime.open({ ...request, sessionId: "session-2" })).close();
  expect(runtime.loadCount).toBe(1);
});
```

`FakeRuntime` increments `loadCount` only inside `ready()`, never inside `open()`.

Metrics test: `recordDecode({ sessionId, kind, queueDelayMs, decodeMs, audioMs, realtimeFactor, model })` serializes one JSON line that contains the opaque id and numbers, and does **not** contain sample buffers or transcript text even if the caller also has a `text` local variable. The `MetricsSink.recordDecode` argument type must omit `text` and PCM fields.

- [ ] **Step 2: Confirm red**

```bash
npx vitest run test/gateway.test.ts test/metrics.test.ts test/warmRuntime.test.ts
```

Run from `apps/transcription-server`. Expected: FAIL because the gateway does not exist.

- [ ] **Step 3: Implement admission, metrics, gateway, and a stub main**

`apps/transcription-server/src/admission.ts`:

```ts
export class AdmissionPool {
  private active = 0;
  public constructor(private readonly capacity: number) {}
  public reserve(): (() => void) | undefined {
    if (this.active >= this.capacity) return undefined;
    this.active += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active -= 1;
      }
    };
  }
}
```

Default capacity is `1`.

`createTranscriptionGateway(options)`:

```ts
export interface GatewayOptions {
  host: string;
  port: number;
  runtime: StreamingRuntime;
  capacity?: number;
  allowedOrigins: readonly string[];
}
```

Implementation rules:

- Call `assertLoopbackBindHost(host)` before listen.
- Require subprotocol `voice-transcription.v1`.
- Await `runtime.ready()` before sending `session.accepted`.
- First text message must be `session.start`. Validate with `validateClientControl`. Reserve admission **before** `runtime.open`. If reserve fails, emit fatal `RESOURCE_EXHAUSTED` and close `4000`.
- Then `session.accepted` with `runtime.modelName` and `runtime.backend`.
- Binary frames go through `decodePcmMessage`, then `scheduler.push`, then `audio.ack` with that frame’s sequence.
- Create one `SessionScheduler` per accepted session. Forward `emit` as `{ type: "engine.event", event }`.
- On socket close, `cancel()` if not already terminal, `release()` admission, `runtimeSession.close()`.
- Do not read an `access_token`. There is no `authenticate` callback.

`main.ts` for this task may start with a fake in-process runtime only if `VOICE_FAKE_RUNTIME=1`; production native wiring is Task 10. Still parse:

- `VOICE_HOST` default `127.0.0.1`
- `VOICE_PORT` default `8787`
- `VOICE_ALLOWED_ORIGINS` default `http://localhost:5173`
- `VOICE_MAX_SESSIONS` default `1`
- `VOICE_MODEL_PATH` / `VOICE_VAD_MODEL_PATH` required unless `VOICE_FAKE_RUNTIME=1`

Missing required production values fail startup with one explicit error. Binding uses `VOICE_HOST` after `assertLoopbackBindHost`.

- [ ] **Step 4: Verify server tests**

```bash
npm test --workspace @voice/transcription-server
npm run build --workspace @voice/transcription-server
```

Expected: gateway, metrics, warm-runtime, and scheduler tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/transcription-server
git add -f apps/transcription-server/dist
git commit -m "feat: serve localhost streaming sessions"
```

---

### Task 7: Wire Live (this PC) into the web UI

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/vite-env.d.ts`
- Modify: `apps/web/src/features/transcription/sessionController.ts`
- Modify: `apps/web/src/features/transcription/TranscriptionAdapter.tsx`
- Modify: `apps/web/src/app.css`
- Modify: `apps/web/src/features/transcription/TranscriptionAdapter.test.tsx`
- Modify: `apps/web/tests/e2e/transcription.spec.ts`
- Modify: `package-lock.json`

- [ ] **Step 1: Add the dependency and red UI tests**

Add `"@voice/remote-whisper-engine": "*"` to `apps/web` dependencies and run `npm install`.

Extend `apps/web/src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TRANSCRIPTION_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

In `TranscriptionAdapter.test.tsx`, mock `@voice/remote-whisper-engine` the same way the file already mocks the local engine (a hoisted `created` counter). Assert:

- default construction with `import.meta.env.VITE_TRANSCRIPTION_WS_URL = "ws://127.0.0.1:8787"` creates the remote engine, not the local one
- the UI shows `Live (this PC)`
- clicking `Offline local` then Start creates the local engine
- a non-final segment paragraph has class `transcript-segment--provisional` and `data-final="false"`
- a later final revision with the same `id` replaces that paragraph rather than appending
- the visual `.transcript` is `aria-live="off"`
- a visually hidden `aria-live="polite"` region contains only finalized segment text

Stub `import.meta.env.VITE_TRANSCRIPTION_WS_URL` with Vitest `vi.stubEnv` if available, or a small `getTranscriptionEndpoint()` seam in the adapter that tests can override.

- [ ] **Step 2: Confirm red**

```bash
npm test --workspace @voice/web -- src/features/transcription/TranscriptionAdapter.test.tsx
```

Expected: FAIL because the mode selector and provisional markup do not exist.

- [ ] **Step 3: Implement engine selection**

Add to `SessionController`:

```ts
public async resetEngine(): Promise<void> {
  await this.stop();
  await this.dropEngine();
}
```

Change the backpressure string from “local model” to “transcription service”:

```ts
this.onBackpressureWarning("Audio is arriving faster than the transcription service can process it; the oldest queued frame was dropped.");
```

In `TranscriptionAdapter.tsx`:

```ts
type EngineMode = "live" | "offline";

function createEngine(mode: EngineMode, onProgress: (value: number) => void): TranscriptionEngine {
  if (mode === "offline") return new LocalWhisperEngine({ onProgress });
  const endpoint = import.meta.env.VITE_TRANSCRIPTION_WS_URL ?? "ws://127.0.0.1:8787";
  return new RemoteWhisperEngine({ endpoint });
}
```

Keep injected `engineFactory` for existing tests. Default mode is `"live"` when an endpoint is configured (the `??` default counts as configured). Store mode in state. Mode buttons: `Live (this PC)` and `Offline local`. On mode change, update the ref, `await controller.resetEngine()`, then enable Start. Do not reuse a cached engine from the other mode.

Replace the hard-coded `Local transcription (on this device)` paragraph with the selected mode label.

- [ ] **Step 4: Render provisional and final text accessibly**

One keyed `<p>` per segment:

```tsx
<p
  key={segment.id}
  className={segment.isFinal ? "transcript-segment" : "transcript-segment transcript-segment--provisional"}
  data-final={segment.isFinal ? "true" : "false"}
>
  <span>{segment.text}</span>
  {!segment.isFinal && <span className="transcript-updating"> Updating</span>}
  <small>{segment.language.tag}</small>
</p>
```

Visual `.transcript` gets `aria-live="off"`. Add `.visually-hidden` polite live region that joins `state.segments.filter((segment) => segment.isFinal).map((segment) => segment.text)`.

CSS:

```css
.transcript-segment--provisional span:first-child { opacity: .72; }
.transcript-updating {
  margin-left: 8px;
  color: #9aa7c2;
  font-size: 11px;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

Do not use color alone to mark live text.

- [ ] **Step 5: Add the Playwright live-revision scenario**

Existing e2e tests stub `Worker` for Offline local. Live is now the default, so add a dedicated test file path or `test.describe` that stubs `window.WebSocket` in `addInitScript` (do not rely on an `engineFactory` prop; the production adapter does not expose that in the e2e bundle).

The stub must:

1. record the constructor protocols and include `voice-transcription.v1`
2. on `send` of `session.start`, reply with `session.accepted` `{ sessionId, model: "small", backend: "cpu" }`, then `engine.event` `listening`, then revision 0 non-final `"I would"`
3. then revision 1 `"I would like"` with the same segment `id`
4. on `session.stop`, emit final `"I would like to reserve a room."` then `stopped`
5. ACK each binary PCM with `audio.ack`

Assert there is always one `[data-final]` paragraph for that caption, that `Updating` is visible during the provisional, and that the final text appears before Standby.

Existing Worker-based tests must explicitly choose Offline local (click that control) so they do not hit the real WebSocket.

- [ ] **Step 6: Verify web tests**

```bash
npm test --workspace @voice/web
npm run typecheck --workspace @voice/web
npm run test:e2e --workspace @voice/web
```

Expected: unit tests PASS; Playwright PASS including the new live-revision case.

- [ ] **Step 7: Commit**

```bash
git add package-lock.json apps/web
git commit -m "feat: show live caption revisions from localhost whisper"
```

---

### Task 8: Create the persistent native whisper.cpp addon (JS loader first, then C++)

**Files:**
- Create: `packages/native-whisper-addon/package.json`
- Create: `packages/native-whisper-addon/tsconfig.json`
- Create: `packages/native-whisper-addon/src/types.ts`
- Create: `packages/native-whisper-addon/src/loader.ts`
- Create: `packages/native-whisper-addon/src/index.ts`
- Create: `packages/native-whisper-addon/CMakeLists.txt`
- Create: `packages/native-whisper-addon/native/addon.cpp`
- Test: `packages/native-whisper-addon/test/loader.test.ts`
- Test: `packages/native-whisper-addon/test/nativeSmoke.test.ts`

- [ ] **Step 1: Create a workspace whose ordinary build does not compile C++**

```json
{
  "name": "@voice/native-whisper-addon",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "build:native": "cmake-js compile -T native-whisper-addon -B Release",
    "test": "vitest run"
  },
  "dependencies": {
    "node-addon-api": "8.5.0"
  },
  "devDependencies": {
    "cmake-js": "7.3.1",
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

Pin the newest published 8.x `node-addon-api` and 7.x `cmake-js` if those exact versions are missing. No `postinstall` / install hook. Same NodeNext tsconfig as other packages.

- [ ] **Step 2: Write red loader tests**

Inject `loadBinary(path: string): unknown` into `loadNativeWhisperAddon`. Assert:

- missing binary throws `Native whisper addon is not built; run npm run build:native --workspace @voice/native-whisper-addon`
- a fake module missing `createRuntime` throws `/createRuntime/`
- a fake module with `createRuntime` returns that object

Default binary path: `packages/native-whisper-addon/build/Release/native-whisper-addon.node` resolved from `import.meta.url`.

- [ ] **Step 3: Confirm red**

```bash
npm test --workspace @voice/native-whisper-addon
```

Expected: FAIL because the loader does not exist.

- [ ] **Step 4: Define the JS/native API and implement the loader**

`packages/native-whisper-addon/src/types.ts`:

```ts
export interface NativeDecodeResult {
  text: string;
  language: string;
  languageProbability: number;
  startMs: number;
  endMs: number;
}

export interface NativeRuntimeHandle {
  pushVad(samples: Int16Array): Float32Array;
  decode(samples: Int16Array, prompt: string): Promise<NativeDecodeResult>;
  warmup(): Promise<void>;
  reset(): void;
  close(): void;
}

export interface NativeAddon {
  createRuntime(options: {
    modelPath: string;
    vadModelPath: string;
    threads: number;
    useGpu: boolean;
  }): NativeRuntimeHandle;
}
```

`createRuntime` loads both models **once**. `warmup()` runs one bounded silent decode so lazy allocations finish. `close()` frees contexts. `reset()` clears VAD carry/state without unloading weights.

- [ ] **Step 5: Implement CMake and the persistent `ObjectWrap`**

`CMakeLists.txt` must:

- `add_subdirectory(../../vendor/whisper.cpp whisper.cpp)`
- force `WHISPER_BUILD_EXAMPLES`, `WHISPER_BUILD_TESTS`, and `WHISPER_BUILD_SERVER` off
- build a Node addon named `native-whisper-addon` from `native/addon.cpp`
- link `whisper` and `node-addon-api`

`native/addon.cpp` (`WhisperRuntimeWrap`):

- owns one `whisper_context*` and one `whisper_vad_context*`
- constructor loads both models exactly once; throw if either path contains `.en`
- `pushVad()` appends each 320-sample int16 frame, regroups into 512-sample Silero windows, calls `whisper_vad_detect_speech_no_reset` (or the equivalent v1.9.2 API already used in `packages/local-whisper-engine/native/bridge.cpp`), returns newly available probabilities, keeps leftover carry samples
- `decode()` copies the `Int16Array`, runs `Napi::AsyncWorker`, greedy `whisper_full`, `translate = false`, language auto, timestamps off, `single_segment = true`, prompt tokens from the JS string, one mutex so two decodes cannot share the handle
- `warmup()` decodes a short silent buffer
- `reset()` / `close()` as specified; `close()` is idempotent

Do not modify files under `vendor/whisper.cpp`.

Windows: document in the addon README (Task 11) that `build:native` needs CMake and a C++17 toolchain (Visual Studio Build Tools or LLVM). `useGpu: true` is a compile-time CUDA/Vulkan build plus that flag; default CPU.

- [ ] **Step 6: Optional native smoke, always-safe CI**

`test/nativeSmoke.test.ts`: if `VOICE_MODEL_PATH` and `VOICE_VAD_MODEL_PATH` are unset, `it.skip` with message `native smoke skipped`. If `VOICE_REQUIRE_NATIVE_TEST=1` and they are unset, `it` **fails**. When set, load once, `warmup()`, transcribe `apps/web/tests/fixtures/jfk.wav` (reuse the existing fixture), and expect the text to match `/Kennedy/i`. Call `createRuntime` once and `open`-equivalent `decode` twice; assert no second model file read if the wrapper exposes `loadCount`, otherwise assert the process does not call `createRuntime` twice.

Ordinary `npm test --workspace @voice/native-whisper-addon` must PASS on a machine without the `.node` binary (loader tests only; smoke skipped).

- [ ] **Step 7: Commit**

```bash
git add package-lock.json packages/native-whisper-addon
git add -f packages/native-whisper-addon/dist
git commit -m "feat: add persistent native whisper runtime"
```

Do not commit `build/Release/*.node` or downloaded models.

---

### Task 9: Connect one warm native handle to the server

**Files:**
- Create: `apps/transcription-server/src/nativeRuntime.ts`
- Modify: `apps/transcription-server/src/main.ts`
- Modify: `apps/transcription-server/package.json`
- Test: `apps/transcription-server/test/nativeRuntime.test.ts`

- [ ] **Step 1: Write red adapter tests with a fake native handle**

Inject `createHandle()`. Assert:

- `ready()` calls `createHandle` once, then `warmup()` once, and sets `loadCount` to 1
- two `open()` calls reuse that handle (createHandle still 1); they must not overlap: a second `open` while the first session is unclosed throws / the gateway already prevents this, but the adapter should `throw` if `busy`
- `push` converts PCM to int16, calls `pushVad`, feeds returned probabilities into `createVadGate()`, and maps `flush` to `speechEnded` / `maxDuration`
- `decode` forwards to the handle and races against `decodeTimeoutMs` (default 30_000); on timeout, `close()` the handle, `createHandle`+`warmup` again (this **does** increment `loadCount`), and the session errors `TIMEOUT`
- `close()` on the session calls `reset()` not `close()` on a healthy handle
- process shutdown calls handle `close()` once
- `modelName` is the file basename; paths containing `.en` are rejected before `createHandle`

- [ ] **Step 2: Confirm red**

```bash
npx vitest run test/nativeRuntime.test.ts
```

Run from `apps/transcription-server`. Expected: FAIL because `nativeRuntime.ts` is missing.

- [ ] **Step 3: Implement the adapter and production `main.ts`**

`createNativeStreamingRuntime({ modelPath, vadModelPath, threads, useGpu, loadAddon })` returns `StreamingRuntime`.

`main.ts`:

- If `VOICE_FAKE_RUNTIME=1`, keep the fake runtime for demos without C++.
- Else load `@voice/native-whisper-addon`, reject `.en` paths with `VOICE_MODEL_PATH must reference a multilingual model`, `await runtime.ready()` **before** `listen`, then pass the runtime into `createTranscriptionGateway`.
- `VOICE_USE_GPU` is `1`/`0`, default `0`.
- Signal handlers (`SIGINT`, `SIGTERM`): stop admission, close sockets, await active session `close` for at most 10 s, then `handle.close()` and HTTP close.

Add `"@voice/native-whisper-addon": "*"` to server dependencies.

- [ ] **Step 4: Verify fake-handle tests**

```bash
npm test --workspace @voice/transcription-server
npm run typecheck --workspace @voice/transcription-server
```

Expected: PASS without loading a real addon.

- [ ] **Step 5: Commit**

```bash
git add package-lock.json apps/transcription-server
git add -f apps/transcription-server/dist
git commit -m "feat: keep one warm native whisper handle"
```

---

### Task 10: Checksum-verified live models and a same-PC benchmark

**Files:**
- Create: `apps/transcription-server/scripts/fetch-server-models.mjs`
- Create: `apps/transcription-server/scripts/benchmark.mjs`
- Create: `apps/transcription-server/test/modelProvisioning.test.ts`
- Modify: `apps/transcription-server/package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Write red provisioning tests**

Factor download/hash behind injected `fetch` and filesystem functions. Test:

- valid cache reuse (matching sha256, no second fetch)
- checksum mismatch deletes the partial file and throws
- interrupted download leaves no `*.partial` after the error path
- `--model tiny.en` / any name containing `.en` throws before fetch
- `--model small` writes `apps/transcription-server/models/ggml-small.bin`

- [ ] **Step 2: Implement the fetcher**

Mirror `scripts/fetch-models.mjs` (temp file, rename, pinned sha256). Models:

| `--model` | file | url | sha256 |
| --- | --- | --- | --- |
| `base` | `ggml-base.bin` | `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin` | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` |
| `small` | `ggml-small.bin` | `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin` | `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` |
| `medium` | `ggml-medium.bin` | `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin` | `6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208` |
| `vad` | `ggml-silero-v6.2.0.bin` | `https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin` | `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987` |

Default CLI: `node scripts/fetch-server-models.mjs --model small` also fetches `vad` if missing. Never download `medium` unless asked. Never download `.en`.

Scripts on the server package:

```json
"fetch-models": "node scripts/fetch-server-models.mjs",
"benchmark": "node scripts/benchmark.mjs"
```

`.gitignore` add:

```
apps/transcription-server/models/
apps/transcription-server/benchmark-results/
```

- [ ] **Step 3: Implement the local benchmark**

`benchmark.mjs` opens **one** WebSocket session to `ws://127.0.0.1:$VOICE_PORT`, feeds fixture PCM in real time, and prints one JSON line:

```json
{
  "firstPartialP95Ms": 0,
  "refreshP95Ms": 0,
  "finalAfterSilenceP95Ms": 0,
  "realTimeFactor": 0,
  "sessions": 1,
  "model": "small",
  "backend": "cpu",
  "loadCount": 1
}
```

Exit nonzero unless `firstPartialP95Ms <= 1500`, `refreshP95Ms <= 1000`, and `finalAfterSilenceP95Ms <= 1500`. If CPU `small` fails, the operator reruns with `--model base`; do not change the default in code until that evidence exists. Write the JSON under gitignored `benchmark-results/`. Do not log caption text.

This step’s unit tests mock the socket; they must not require a GPU.

- [ ] **Step 4: Verify provisioning tests**

```bash
npm test --workspace @voice/transcription-server
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .gitignore apps/transcription-server
git commit -m "feat: fetch and benchmark localhost whisper models"
```

---

### Task 11: Root build order and documentation

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Create: `packages/streaming-protocol/README.md`
- Create: `packages/remote-whisper-engine/README.md`
- Create: `apps/transcription-server/README.md`
- Create: `packages/native-whisper-addon/README.md`

- [ ] **Step 1: Make clean-checkout build order explicit**

Replace the root `"build"` script with:

```json
"build": "npm run build --workspace @voice/transcription-contracts && npm run build --workspace @voice/streaming-protocol && npm run build --workspace @voice/local-whisper-engine && npm run build --workspace @voice/remote-whisper-engine && npm run build --workspace @voice/native-whisper-addon && npm run build --workspace @voice/transcription-server && npm run build --workspace @voice/web"
```

Keep `"test"` and `"typecheck"` building first. Add convenience scripts:

```json
"dev:web": "npm run dev --workspace @voice/web",
"dev:transcribe": "npm run dev --workspace @voice/transcription-server"
```

Ordinary `npm install` must still **not** compile the native addon.

- [ ] **Step 2: Document the two modes and how to run them on Windows**

README / CLAUDE.md must describe:

```text
Live (this PC): microphone -> ws://127.0.0.1:8787 -> warm native Whisper -> provisional/final revisions -> UI
Offline local: microphone -> browser Worker -> WASM tiny Whisper -> final-only text
```

Document this operator sequence:

1. `npm install`
2. `npm run build:native --workspace @voice/native-whisper-addon`
3. `npm run fetch-models --workspace @voice/transcription-server -- --model small`
4. set `VOICE_MODEL_PATH` and `VOICE_VAD_MODEL_PATH` to those files
5. `npm run dev:transcribe` (this is the warm load; wait until the log says ready)
6. `npm run dev:web` and press Start

Document Offline local when the server is not running. Document loopback-only bind, no persistence, no `.en` models, fake-runtime CI path, and that a native timeout recycles the handle (reload once, recovery only).

Native README: CMake + C++17 toolchain on Windows; `VOICE_USE_GPU=1` only after a CUDA/Vulkan compile; default CPU.

Protocol README: 656-byte layout, one session per socket, ACK semantics.

- [ ] **Step 3: Build generated TypeScript outputs**

```bash
npm run build
```

Expected: every workspace builds in that order.

- [ ] **Step 4: Commit**

```bash
git add package.json README.md CLAUDE.md packages/streaming-protocol/README.md packages/remote-whisper-engine/README.md packages/native-whisper-addon/README.md apps/transcription-server/README.md
git add -f packages/streaming-protocol/dist packages/remote-whisper-engine/dist packages/native-whisper-addon/dist apps/transcription-server/dist
git commit -m "docs: describe localhost live captions"
```

---

### Task 12: Final verification

**Files:**
- Modify only if a failing check exposes a defect; return to that task’s test first.

- [ ] **Step 1: Repository hygiene**

```bash
git status --short
git submodule status
git diff --check
```

Expected: no leftover unstaged work, whisper.cpp submodule initialized, no whitespace errors. `vendor/whisper.cpp` has no local patches.

- [ ] **Step 2: Deterministic matrix (no CMake, no GPU)**

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run test:e2e --workspace @voice/web
```

Expected: all exit 0.

- [ ] **Step 3: Real native smoke on this PC (manual, not CI)**

```bash
npm run build:native --workspace @voice/native-whisper-addon
npm run fetch-models --workspace @voice/transcription-server -- --model small
```

PowerShell:

```powershell
$env:VOICE_MODEL_PATH = (Resolve-Path 'apps/transcription-server/models/ggml-small.bin').Path
$env:VOICE_VAD_MODEL_PATH = (Resolve-Path 'apps/transcription-server/models/ggml-silero-v6.2.0.bin').Path
$env:VOICE_REQUIRE_NATIVE_TEST = '1'
npm run test --workspace @voice/native-whisper-addon
```

Expected: model loads once, JFK text contains `Kennedy`.

Then start the server, start the web app, speak, and confirm a dim/updating line appears **before** you pause, then locks after silence.

If `small` misses the 1.5 s / 1 s / 1.5 s gates on CPU, rerun fetch+benchmark with `--model base` and record the chosen default in `apps/transcription-server/README.md` in a follow-up commit. Do not silently keep a failing default.

---

## Spec coverage checklist

| Spec requirement | Task |
| --- | --- |
| 656-byte PCM + control messages | 1, 2 |
| Loopback-only URL and bind | 2, 6 |
| Remote `TranscriptionEngine` + backpressure | 3, 4 |
| Rolling 750 ms provisionals, 500 ms final, 25 s split | 5 |
| Coalesce ticks, final preempts provisional | 5 |
| Warm load once, no idle unload | 6, 9 |
| One session, `RESOURCE_EXHAUSTED` | 6 |
| Metrics without caption/audio text | 6 |
| Live (this PC) vs Offline local UI + a11y | 7 |
| Native persistent context, Windows CPU default | 8, 9 |
| Timeout recycles handle (reload on recovery only) | 9 |
| Checksum models, no `.en`, local latency gates | 10 |
| Docs, two-process runbook | 11 |
| Full verification | 12 |

Out of scope (spec non-goals, no task): conversational agent, cloud `wss` auth, CUDA Docker image, idle unload, word-by-word non-Whisper ASR, Siri/iOS.
