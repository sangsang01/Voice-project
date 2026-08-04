# Browser and Local Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing browser frontend to microphone capture and a local, cached, multilingual Whisper engine while establishing the frozen contract used by both coding agents.

**Architecture:** The React UI talks only to `TranscriptionEngine`. An AudioWorklet produces bounded 16-kHz PCM frames, and a dedicated worker runs Whisper through Transformers.js. Transcript state is reducer-owned and consumes revision-safe normalized events.

**Tech Stack:** npm workspaces, TypeScript, existing React/Vite frontend, Vitest, React Testing Library, Playwright, Web Audio API, Web Workers, WebGPU/WASM, `@huggingface/transformers`, `franc-min`.

---

## File map and ownership

Agent 1 owns root workspace files during bootstrap, `packages/transcription-contracts/**`, `apps/web/**`, and `packages/local-whisper-engine/**`. After the bootstrap commit, do not change the contract without stopping Agent 2.

```text
package.json                                      workspace scripts only
tsconfig.base.json                               strict shared TypeScript options
packages/transcription-contracts/src/types.ts    audio/session/segment types
packages/transcription-contracts/src/events.ts   normalized engine events
packages/transcription-contracts/src/engine.ts   engine/session interfaces
packages/transcription-contracts/src/validation.ts runtime invariants
packages/transcription-contracts/src/testing/contractSuite.ts reusable provider suite
packages/local-whisper-engine/src/LocalWhisperEngine.ts contract adapter
packages/local-whisper-engine/src/worker/localWhisper.worker.ts inference owner
packages/local-whisper-engine/src/worker/protocol.ts worker messages
packages/local-whisper-engine/src/browser/capabilities.ts WebGPU/WASM selection
packages/local-whisper-engine/src/cache/modelCache.ts versioned model cache metadata
packages/local-whisper-engine/src/segmentation/languageLabeler.ts candidate labels
apps/web/src/features/transcription/sessionReducer.ts event-safe transcript state
apps/web/src/features/transcription/sessionController.ts lifecycle and backpressure
apps/web/src/features/transcription/audio/microphone.ts media stream lifecycle
apps/web/src/features/transcription/audio/pcm-worklet.ts PCM conversion
apps/web/src/features/transcription/TranscriptionAdapter.tsx existing-UI wiring
apps/web/src/features/transcription/CloudConsentDialog.tsx explicit upload consent
apps/web/src/App.tsx                              one composition change
```

## Task 1: Bootstrap the workspace and freeze the shared contract

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `packages/transcription-contracts/package.json`
- Create: `packages/transcription-contracts/tsconfig.json`
- Create: `packages/transcription-contracts/src/types.ts`
- Create: `packages/transcription-contracts/src/events.ts`
- Create: `packages/transcription-contracts/src/engine.ts`
- Create: `packages/transcription-contracts/src/validation.ts`
- Create: `packages/transcription-contracts/src/index.ts`
- Create: `packages/transcription-contracts/test/validation.test.ts`

- [ ] **Step 1: Create the failing validation tests**

```ts
import { describe, expect, it } from "vitest";
import { validateSessionRequest } from "../src/validation";

const valid = {
  sessionId: "session-1",
  candidateLanguages: ["vi-VN", "en-US", "es-ES", "zh-CN"],
  mode: "transcribe",
  audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
} as const;

describe("validateSessionRequest", () => {
  it("accepts one through four unique languages", () => {
    expect(validateSessionRequest(valid)).toEqual(valid);
  });

  it.each([
    { ...valid, candidateLanguages: [] },
    { ...valid, candidateLanguages: ["en-US", "en-US"] },
    { ...valid, candidateLanguages: ["en-US", "vi-VN", "es-ES", "zh-CN", "fr-FR"] },
    { ...valid, audio: { ...valid.audio, sampleRateHz: 44100 } },
  ])("rejects invalid requests", (request) => {
    expect(() => validateSessionRequest(request)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `npm test --workspace @voice/transcription-contracts -- validation.test.ts`

Expected: FAIL because `src/validation.ts` does not exist.

- [ ] **Step 3: Add the workspace manifests and contract types**

Use the exact contract from `docs/superpowers/specs/2026-08-04-multilingual-realtime-transcription-design.md`. Implement `validateSessionRequest` with these concrete checks:

```ts
export function validateSessionRequest(value: unknown): SessionRequest {
  if (!value || typeof value !== "object") throw new TypeError("request must be an object");
  const request = value as SessionRequest;
  const languages = [...request.candidateLanguages];
  if (languages.length < 1 || languages.length > 4) throw new RangeError("select 1-4 languages");
  if (new Set(languages).size !== languages.length) throw new TypeError("languages must be unique");
  if (languages.some((tag) => !/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2})?$/.test(tag))) {
    throw new TypeError("languages must be BCP-47 tags");
  }
  if (request.mode !== "transcribe") throw new TypeError("mode must be transcribe");
  if (request.audio.encoding !== "pcm_s16le" || request.audio.sampleRateHz !== 16000 || request.audio.channels !== 1 || request.audio.frameDurationMs !== 20) {
    throw new TypeError("audio must be 16-kHz mono PCM with 20-ms frames");
  }
  return request;
}
```

Root `package.json` must use npm workspaces for `apps/*` and `packages/*` and expose `test`, `typecheck`, and `lint` scripts without adding application dependencies at the root.

- [ ] **Step 4: Run contract tests and typecheck**

Run: `npm test --workspace @voice/transcription-contracts && npm run typecheck --workspace @voice/transcription-contracts`

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 5: Commit and notify Agent 2 of the hash**

```bash
git add package.json tsconfig.base.json packages/transcription-contracts
git commit -m "feat: establish transcription engine contracts"
git rev-parse HEAD
```

Expected: one commit hash that Agent 2 uses as its branch/worktree base.

## Task 2: Add the reusable engine conformance suite

**Files:**
- Create: `packages/transcription-contracts/src/testing/contractSuite.ts`
- Create: `packages/transcription-contracts/src/testing/fakeEngine.ts`
- Modify: `packages/transcription-contracts/src/index.ts`
- Test: `packages/transcription-contracts/test/contractSuite.test.ts`

- [ ] **Step 1: Write a failing fake-engine conformance test**

The suite must assert `prepare -> open -> listening -> stop -> stopped`, monotonic event sequences, accepted 320-sample frames, rejection after stop, no events after `stop()` resolves, and immediate `cancel()`.

```ts
describeEngineContract("fake", () => new FakeTranscriptionEngine(), {
  request: makeSessionRequest(["en-US", "vi-VN"]),
  frame: makePcmFrame(0),
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test --workspace @voice/transcription-contracts -- contractSuite.test.ts`

Expected: FAIL because `describeEngineContract` is not exported.

- [ ] **Step 3: Implement the suite and deterministic fake**

Use a per-session counter for every emitted event. `stop()` emits `draining`, one final segment, then `stopped`. `cancel()` emits only `stopped`. Both methods become idempotent and prevent subsequent `push()` calls.

- [ ] **Step 4: Run the complete contract package**

Run: `npm test --workspace @voice/transcription-contracts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/transcription-contracts
git commit -m "test: add transcription engine conformance suite"
```

## Task 3: Build reducer-owned session state before UI wiring

**Files:**
- Create: `apps/web/src/features/transcription/sessionReducer.ts`
- Test: `apps/web/src/features/transcription/sessionReducer.test.ts`

- [ ] **Step 1: Test stale sessions, revisions, final immutability, and clearing**

```ts
const initial = createSessionState("session-new");
const provisional = segmentEvent("session-new", 1, { id: "s1", revision: 1, isFinal: false, text: "Xin" });
const revised = segmentEvent("session-new", 2, { id: "s1", revision: 2, isFinal: true, text: "Xin chào" });

expect(sessionReducer(initial, provisional).segments[0].text).toBe("Xin");
expect(sessionReducer(sessionReducer(initial, provisional), revised).segments[0].text).toBe("Xin chào");
expect(sessionReducer(initial, segmentEvent("old", 99, { id: "bad" }))).toEqual(initial);
expect(sessionReducer(sessionReducer(initial, revised), provisional).segments[0].text).toBe("Xin chào");
expect(sessionReducer(initial, { type: "clear", nextSessionId: "session-2" }).segments).toEqual([]);
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test --workspace @voice/web -- sessionReducer.test.ts`

Expected: FAIL because the reducer is missing.

- [ ] **Step 3: Implement a pure reducer**

Store `sessionId`, `lastEventSequence`, `engineState`, an ID-keyed segment map, ordered segment IDs, warnings, and the latest fatal error. Ignore old session IDs, non-increasing event sequences, lower revisions, and all changes to finalized segments.

- [ ] **Step 4: Run reducer tests**

Run: `npm test --workspace @voice/web -- sessionReducer.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/transcription/sessionReducer.ts apps/web/src/features/transcription/sessionReducer.test.ts
git commit -m "feat: add revision-safe transcript reducer"
```

## Task 4: Capture and frame microphone PCM off the React thread

**Files:**
- Create: `apps/web/src/features/transcription/audio/pcm.ts`
- Create: `apps/web/src/features/transcription/audio/pcm-worklet.ts`
- Create: `apps/web/src/features/transcription/audio/microphone.ts`
- Test: `apps/web/src/features/transcription/audio/pcm.test.ts`
- Test: `apps/web/src/features/transcription/audio/microphone.test.ts`

- [ ] **Step 1: Write resampling and lifecycle tests**

Test that 48-kHz float input becomes clamped 16-kHz `Int16Array`, every emitted frame contains 320 samples, frame sequences are monotonic, permission denial maps to `UNAVAILABLE`, and `stop()` releases every media track and closes the `AudioContext` once.

- [ ] **Step 2: Run and verify failure**

Run: `npm test --workspace @voice/web -- pcm.test.ts microphone.test.ts`

Expected: FAIL because audio modules are missing.

- [ ] **Step 3: Implement conversion and worklet protocol**

```ts
export function floatToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const value = Math.max(-1, Math.min(1, input[index]));
    output[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return output;
}
```

The worklet accumulates resampled samples until 320 are available, transfers the underlying buffer, and never touches React state. `microphone.ts` owns `getUserMedia`, worklet registration, track cleanup, and abort handling.

- [ ] **Step 4: Run audio tests**

Run: `npm test --workspace @voice/web -- pcm.test.ts microphone.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/transcription/audio
git commit -m "feat: capture bounded 16-khz microphone frames"
```

## Task 5: Add local capability selection and cache metadata

**Files:**
- Create: `packages/local-whisper-engine/package.json`
- Create: `packages/local-whisper-engine/tsconfig.json`
- Create: `packages/local-whisper-engine/src/browser/capabilities.ts`
- Create: `packages/local-whisper-engine/src/cache/modelCache.ts`
- Create: `packages/local-whisper-engine/src/modelManifest.ts`
- Test: `packages/local-whisper-engine/test/capabilities.test.ts`
- Test: `packages/local-whisper-engine/test/modelCache.test.ts`

- [ ] **Step 1: Test deterministic device selection**

Test WebGPU preference, WASM fallback, unavailable state, version mismatch eviction, insufficient-storage warning, progress events, and cache reuse.

- [ ] **Step 2: Run and verify failure**

Run: `npm test --workspace @voice/local-whisper-engine`

Expected: FAIL because the package is not implemented.

- [ ] **Step 3: Implement the fixed model manifest**

```ts
export const LOCAL_MODEL = {
  id: "onnx-community/whisper-tiny",
  revision: "main",
  cacheVersion: 1,
  task: "automatic-speech-recognition",
} as const;
```

`inspectLocalCapabilities()` returns `webgpu`, `wasm`, or `unavailable` plus storage estimates. Cache metadata includes model ID, revision, cache version, and completion state; an interrupted download is never marked complete.

- [ ] **Step 4: Run tests**

Run: `npm test --workspace @voice/local-whisper-engine`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/local-whisper-engine
git commit -m "feat: add local model capability and cache policy"
```

## Task 6: Implement the worker and local engine contract

**Files:**
- Create: `packages/local-whisper-engine/src/worker/protocol.ts`
- Create: `packages/local-whisper-engine/src/worker/localWhisper.worker.ts`
- Create: `packages/local-whisper-engine/src/LocalWhisperEngine.ts`
- Create: `packages/local-whisper-engine/src/index.ts`
- Test: `packages/local-whisper-engine/test/LocalWhisperEngine.test.ts`
- Test: `packages/local-whisper-engine/test/contract.test.ts`

- [ ] **Step 1: Write worker and contract tests with an injected fake runtime**

Assert model-load progress, frame order, bounded buffering, stable segment IDs across revisions, draining stop, immediate cancel, worker termination, WebGPU-to-WASM retry exactly once, and no events after closure.

- [ ] **Step 2: Run and verify failure**

Run: `npm test --workspace @voice/local-whisper-engine -- LocalWhisperEngine.test.ts contract.test.ts`

Expected: FAIL because `LocalWhisperEngine` is missing.

- [ ] **Step 3: Implement the runtime boundary**

```ts
export interface WhisperRuntime {
  load(options: { device: "webgpu" | "wasm"; onProgress(progress: number): void }, signal: AbortSignal): Promise<void>;
  transcribe(samples: Float32Array, signal: AbortSignal): Promise<{ text: string; startMs: number; endMs: number }>;
  dispose(): Promise<void>;
}
```

Production constructs the Transformers.js ASR pipeline in the worker with the manifest model, the selected `webgpu` or `wasm` device, and quantized `q8` weights. Tests inject a deterministic runtime and assert those load options. Use short overlapping voice windows, transferable buffers, and a fixed maximum buffered duration. Emit `DEGRADED_PERFORMANCE` when inference remains slower than realtime for three windows.

- [ ] **Step 4: Run the local conformance suite**

Run: `npm test --workspace @voice/local-whisper-engine`

Expected: PASS, including the shared contract suite.

- [ ] **Step 5: Commit**

```bash
git add packages/local-whisper-engine
git commit -m "feat: run local whisper behind engine contract"
```

## Task 7: Add candidate-constrained segment labels

**Files:**
- Create: `packages/local-whisper-engine/src/segmentation/languageLabeler.ts`
- Test: `packages/local-whisper-engine/test/languageLabeler.test.ts`

- [ ] **Step 1: Test the portfolio phrase and uncertainty behavior**

Use individual stable segments for `Xin chào`, `My name is Sang`, `Soy de Vietnam`, and `祝你有美好的一天`. Assert that labels are restricted to the selected set, unsupported winners become `und`, a low score becomes `und`, and one contrary provisional result does not flip a stable label.

- [ ] **Step 2: Run and verify failure**

Run: `npm test --workspace @voice/local-whisper-engine -- languageLabeler.test.ts`

Expected: FAIL because the labeler is missing.

- [ ] **Step 3: Implement text-assisted candidate scoring**

Map selected BCP-47 base languages to ISO-639-3 codes used by `franc-min`; score only those codes. Detect Han script before the Latin-language scorer. Require the winner to exceed the configured confidence threshold twice before changing an existing label; otherwise emit `und` and `LANGUAGE_UNCERTAIN`.

- [ ] **Step 4: Run tests**

Run: `npm test --workspace @voice/local-whisper-engine -- languageLabeler.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/local-whisper-engine/src/segmentation packages/local-whisper-engine/test/languageLabeler.test.ts
git commit -m "feat: label candidate languages conservatively"
```

## Task 8: Wire the existing frontend without redesigning it

**Files:**
- Create: `apps/web/src/features/transcription/sessionController.ts`
- Create: `apps/web/src/features/transcription/TranscriptionAdapter.tsx`
- Create: `apps/web/src/features/transcription/CloudConsentDialog.tsx`
- Test: `apps/web/src/features/transcription/TranscriptionAdapter.test.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Write component tests against the fake engine**

Assert language-limit validation, Start permission flow, Stop draining, Clear & Restart session replacement, partial-to-final rendering, language badges, progress display, stale-event rejection, backpressure warning, local failure, and explicit cloud consent.

- [ ] **Step 2: Run and verify failure**

Run: `npm test --workspace @voice/web -- TranscriptionAdapter.test.tsx`

Expected: FAIL because the adapter is missing.

- [ ] **Step 3: Implement the controller lifecycle**

The controller creates a fresh `crypto.randomUUID()` for every Start/Restart, opens the engine before microphone capture, pushes frames synchronously, discards the oldest queued frame on backpressure, and invalidates the session ID before canceling on Clear. It must release microphone and engine resources in a `finally` path.

- [ ] **Step 4: Compose the adapter once**

Add one `TranscriptionAdapter` import and one rendered adapter boundary to `apps/web/src/App.tsx`. Reuse existing buttons, language controls, status regions, and transcript containers through adapter props or existing component composition. Do not replace styling, routing, or unrelated UI components.

- [ ] **Step 5: Run UI tests and typecheck**

Run: `npm test --workspace @voice/web && npm run typecheck --workspace @voice/web`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/transcription apps/web/src/App.tsx
git commit -m "feat: wire existing ui to transcription engines"
```

## Task 9: Add browser verification and portfolio documentation

**Files:**
- Create: `apps/web/tests/e2e/transcription.spec.ts`
- Create: `apps/web/tests/fixtures/four-language.wav`
- Create: `apps/web/tests/fixtures/LICENSE.md`
- Create: `README.md`

- [ ] **Step 1: Add Playwright scenarios**

Cover fake microphone Start/Stop, rapid Clear & Restart, permission denial, worker crash, cached reload, and WebGPU-disabled fallback. Keep model-dependent accuracy out of blocking browser tests.

- [ ] **Step 2: Add the non-blocking benchmark command**

The benchmark reports first provisional latency, final latency, realtime factor, peak queued audio, and expected-vs-detected segment labels for the licensed fixture. It exits successfully after writing metrics unless the pipeline crashes or produces no final text.

- [ ] **Step 3: Document setup and limitations**

README sections must cover local prerequisites, first model download, offline reuse, browser support, privacy, four-language selection, cloud consent, known utterance-level labeling limitations, test commands, and benchmark interpretation.

- [ ] **Step 4: Run the full Agent 1 verification**

Run: `npm test && npm run typecheck && npm run lint && npm run test:e2e --workspace @voice/web`

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests README.md
git commit -m "test: verify local multilingual transcription flow"
```
