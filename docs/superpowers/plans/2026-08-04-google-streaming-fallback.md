# Google Streaming Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional Node WebSocket gateway and Google Cloud Speech-to-Text V1 streaming engine that conform to the frozen transcription contract without exposing credentials or storing audio.

**Architecture:** The browser cloud engine serializes session control as JSON and sends PCM as ordered binary frames. `apps/api` validates the protocol and owns lifecycle limits; an injected Google adapter opens `streamingRecognize`, normalizes interim/final results, and closes exactly once on every terminal path.

**Tech Stack:** Node.js, TypeScript, `ws`, Vitest, `@google-cloud/speech` V1, npm workspaces, shared `@voice/transcription-contracts`.

---

## Preconditions and ownership

Start only after Agent 1 publishes the contract/bootstrap commit. Create a separate branch or worktree from that exact commit. Agent 2 exclusively owns `apps/api/**` and `packages/google-transcription-engine/**`. Do not edit root workspace files, `packages/transcription-contracts/**`, `apps/web/**`, or `packages/local-whisper-engine/**`; report dependency or script additions to the integration owner.

```text
packages/google-transcription-engine/src/languageConfig.ts  primary/alternatives mapping
packages/google-transcription-engine/src/normalizeResult.ts provider normalization
packages/google-transcription-engine/src/GoogleStream.ts     injected V1 stream wrapper
packages/google-transcription-engine/src/CloudEngineClient.ts browser WebSocket engine
packages/google-transcription-engine/src/server.ts           server-only export entrypoint
packages/google-transcription-engine/src/browser.ts          browser-safe export entrypoint
apps/api/src/config.ts                                      safe runtime configuration
apps/api/src/websocket/protocol.ts                          JSON/binary protocol validation
apps/api/src/websocket/sessionLimits.ts                     idle/hard/buffer limits
apps/api/src/websocket/transcriptionHandler.ts              one socket/session owner
apps/api/src/server.ts                                      injectable HTTP/WS server
apps/api/src/index.ts                                       production composition only
```

## Task 1: Scaffold owned packages and validate language configuration

**Files:**
- Create: `packages/google-transcription-engine/package.json`
- Create: `packages/google-transcription-engine/tsconfig.json`
- Create: `packages/google-transcription-engine/vitest.config.ts`
- Create: `packages/google-transcription-engine/src/languageConfig.ts`
- Test: `packages/google-transcription-engine/test/languageConfig.test.ts`
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/vitest.config.ts`

- [ ] **Step 1: Write failing primary/alternative tests**

```ts
import { describe, expect, it } from "vitest";
import { toGoogleLanguageConfig } from "../src/languageConfig";

describe("toGoogleLanguageConfig", () => {
  it("maps the first language to primary and the remaining three to alternatives", () => {
    expect(toGoogleLanguageConfig(["vi-VN", "en-US", "es-ES", "zh-CN"])).toEqual({
      languageCode: "vi-VN",
      alternativeLanguageCodes: ["en-US", "es-ES", "zh-CN"],
    });
  });

  it.each([[], ["en-US", "en-US"], ["en-US", "vi-VN", "es-ES", "zh-CN", "fr-FR"]])(
    "rejects invalid candidate set %j",
    (languages) => expect(() => toGoogleLanguageConfig(languages)).toThrow(),
  );
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test --workspace @voice/google-transcription-engine -- languageConfig.test.ts`

Expected: FAIL because `languageConfig.ts` is missing.

- [ ] **Step 3: Implement the mapping through shared validation**

```ts
export function toGoogleLanguageConfig(candidateLanguages: readonly string[]) {
  const unique = [...new Set(candidateLanguages)];
  if (unique.length !== candidateLanguages.length || unique.length < 1 || unique.length > 4) {
    throw new RangeError("Google streaming requires 1-4 unique candidate languages");
  }
  return {
    languageCode: unique[0],
    alternativeLanguageCodes: unique.slice(1),
  };
}
```

- [ ] **Step 4: Run package tests and typecheck**

Run: `npm test --workspace @voice/google-transcription-engine && npm run typecheck --workspace @voice/google-transcription-engine`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/google-transcription-engine
git commit -m "chore: scaffold google transcription fallback"
```

## Task 2: Normalize Google interim and final results

**Files:**
- Create: `packages/google-transcription-engine/src/providerTypes.ts`
- Create: `packages/google-transcription-engine/src/normalizeResult.ts`
- Test: `packages/google-transcription-engine/test/normalizeResult.test.ts`

- [ ] **Step 1: Write failing normalization tests**

Cover empty results, interim result index 4, a revision to the same result, final output, language code outside the selected set, missing confidence, and provider errors. Assert stable ID `google-4`, monotonically increasing revision supplied by the caller, source Unicode preservation, and `und` for an unselected language.

```ts
expect(normalizeGoogleResult(result, context)).toEqual({
  type: "segment.upsert",
  sessionId: "session-1",
  sequence: 7,
  segment: {
    id: "google-4",
    ordinal: 4,
    revision: 2,
    startMs: 1200,
    endMs: 2400,
    text: "Xin chào",
    language: { tag: "vi-VN", confidence: 0.91 },
    isFinal: true,
  },
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test --workspace @voice/google-transcription-engine -- normalizeResult.test.ts`

Expected: FAIL because normalization is missing.

- [ ] **Step 3: Implement a pure normalizer**

Read the first alternative only, convert Google duration fields to milliseconds, trim only surrounding whitespace, preserve all Unicode and punctuation, and return `null` for an empty transcript. Keep Google SDK types inside `providerTypes.ts`; exported engine events use only shared contract types.

- [ ] **Step 4: Run tests**

Run: `npm test --workspace @voice/google-transcription-engine -- normalizeResult.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/google-transcription-engine/src packages/google-transcription-engine/test
git commit -m "feat: normalize google streaming results"
```

## Task 3: Wrap the Google V1 duplex stream with injected credentials

**Files:**
- Create: `packages/google-transcription-engine/src/GoogleStream.ts`
- Create: `packages/google-transcription-engine/src/googleClientFactory.ts`
- Create: `packages/google-transcription-engine/src/server.ts`
- Create: `packages/google-transcription-engine/test/helpers/fakeGoogleStream.ts`
- Test: `packages/google-transcription-engine/test/GoogleStream.test.ts`

- [ ] **Step 1: Test the exact request and ordered PCM forwarding**

The fake Speech client must capture the V1 request and emitted audio. Assert `LINEAR16`, 16000 Hz, one channel, primary language, no more than three alternatives, `interimResults: true`, frame order, backpressure propagation, normalized events, provider-error mapping, and idempotent close.

- [ ] **Step 2: Run and verify failure**

Run: `npm test --workspace @voice/google-transcription-engine -- GoogleStream.test.ts`

Expected: FAIL because `GoogleStream` is missing.

- [ ] **Step 3: Implement the injected factory boundary**

```ts
export interface SpeechClientFactory {
  open(request: GoogleStreamingRequest): GoogleDuplex;
}

export function createProductionSpeechClientFactory(): SpeechClientFactory {
  const client = new v1.SpeechClient(); // Application Default Credentials only
  return { open: (request) => client.streamingRecognize(request) };
}
```

`GoogleStream.write(frame)` converts the precise `Int16Array` view to a Buffer without including unrelated backing-buffer bytes. `close()` removes listeners and ends or destroys the duplex once. Do not accept credential JSON, tokens, or project secrets through constructors exposed to the browser protocol.

Configure package exports so `@voice/google-transcription-engine/server` is the only entrypoint that imports `@google-cloud/speech`. Do not expose a root entrypoint that can accidentally pull the Google SDK into the browser bundle.

- [ ] **Step 4: Run tests and shared conformance adapter tests**

Run: `npm test --workspace @voice/google-transcription-engine`

Expected: PASS without network or Google credentials.

- [ ] **Step 5: Commit**

```bash
git add packages/google-transcription-engine
git commit -m "feat: stream pcm through google speech v1"
```

## Task 4: Define and validate the browser-to-server protocol

**Files:**
- Create: `apps/api/src/websocket/protocol.ts`
- Test: `apps/api/test/protocol.test.ts`

- [ ] **Step 1: Write failing protocol tests**

The first client message must be:

```json
{
  "type": "session.start",
  "request": {
    "sessionId": "session-1",
    "candidateLanguages": ["vi-VN", "en-US", "es-ES", "zh-CN"],
    "mode": "transcribe",
    "audio": {
      "encoding": "pcm_s16le",
      "sampleRateHz": 16000,
      "channels": 1,
      "frameDurationMs": 20
    }
  }
}
```

After acceptance, every binary WebSocket message is exactly one 640-byte PCM frame. JSON control messages are `session.stop`, `session.cancel`, and `session.ping`. Test invalid order, malformed JSON, duplicate starts, unsupported metadata, odd byte length, wrong frame size, and audio before start.

- [ ] **Step 2: Run and verify failure**

Run: `npm test --workspace @voice/api -- protocol.test.ts`

Expected: FAIL because protocol validation is missing.

- [ ] **Step 3: Implement discriminated parsing**

Return validated domain messages rather than raw JSON. Map validation failures to close code `1008`; map oversized frames to `1009`. Never include raw payload content in errors or logs.

- [ ] **Step 4: Run tests**

Run: `npm test --workspace @voice/api -- protocol.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/websocket/protocol.ts apps/api/test/protocol.test.ts
git commit -m "feat: validate cloud transcription websocket protocol"
```

## Task 5: Enforce idle, duration, and buffering limits

**Files:**
- Create: `apps/api/src/config.ts`
- Create: `apps/api/src/websocket/sessionLimits.ts`
- Test: `apps/api/test/sessionLimits.test.ts`

- [ ] **Step 1: Write fake-timer boundary tests**

Assert a 30,000-ms idle timeout, a 600,000-ms hard timeout, timer reset only after valid activity, maximum 640-byte frames, maximum 2 seconds of queued audio, configured concurrent-session rejection, and exact origin allowlisting. Test one millisecond before and exactly at each deadline.

- [ ] **Step 2: Run and verify failure**

Run: `npm test --workspace @voice/api -- sessionLimits.test.ts`

Expected: FAIL because limits are missing.

- [ ] **Step 3: Implement immutable configuration**

```ts
export const DEFAULT_LIMITS = Object.freeze({
  idleTimeoutMs: 30_000,
  hardTimeoutMs: 10 * 60_000,
  frameBytes: 640,
  maxBufferedAudioMs: 2_000,
  maxConcurrentSessions: 20,
});
```

Production may lower these values through validated environment variables. `ALLOWED_ORIGINS` is a required comma-separated list outside test mode; reject a WebSocket upgrade whose `Origin` is not an exact member. Reject non-integer, negative, or enlarged values above documented safe ceilings during startup. Document that the gateway must remain disabled on a public deployment until the deployer adds user authentication.

- [ ] **Step 4: Run tests**

Run: `npm test --workspace @voice/api -- sessionLimits.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config.ts apps/api/src/websocket/sessionLimits.ts apps/api/test/sessionLimits.test.ts
git commit -m "feat: enforce transcription session limits"
```

## Task 6: Own one WebSocket session and clean up exactly once

**Files:**
- Create: `apps/api/src/websocket/transcriptionHandler.ts`
- Create: `apps/api/test/helpers/fakeEngine.ts`
- Test: `apps/api/test/transcriptionHandler.test.ts`
- Test: `apps/api/test/cleanup.test.ts`

- [ ] **Step 1: Test lifecycle and terminal paths**

Cover start, ordered binary frames, normalized outbound events, stop drain, cancel, client disconnect, idle timeout, hard timeout, protocol failure, Google error, and server shutdown. For every terminal path, assert timers are cleared, listeners are removed, the provider closes once, no post-close send occurs, and the session registry releases its entry.

- [ ] **Step 2: Run and verify failure**

Run: `npm test --workspace @voice/api -- transcriptionHandler.test.ts cleanup.test.ts`

Expected: FAIL because the handler is missing.

- [ ] **Step 3: Implement one idempotent finalizer**

```ts
let finalized = false;
async function finalize(kind: "stop" | "cancel" | "disconnect"): Promise<void> {
  if (finalized) return;
  finalized = true;
  limits.dispose();
  socket.removeAllListeners();
  if (kind === "stop") await session.stop();
  else await session.cancel();
  registry.delete(sessionId);
}
```

All terminal paths call this function. Send events only when `socket.readyState === WebSocket.OPEN`. Logs include session ID, durations, counts, and safe error codes; never audio, transcript text, request headers, credentials, or tokens.

- [ ] **Step 4: Run handler tests**

Run: `npm test --workspace @voice/api -- transcriptionHandler.test.ts cleanup.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/websocket/transcriptionHandler.ts apps/api/test
git commit -m "feat: manage cloud transcription websocket sessions"
```

## Task 7: Compose an injectable server and browser cloud engine

**Files:**
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/index.ts`
- Create: `apps/api/test/server.integration.test.ts`
- Create: `packages/google-transcription-engine/src/CloudEngineClient.ts`
- Create: `packages/google-transcription-engine/src/browser.ts`
- Test: `packages/google-transcription-engine/test/CloudEngineClient.test.ts`

- [ ] **Step 1: Write client and server integration tests**

Start a real local ephemeral-port WebSocket server with an injected fake provider. Open `CloudEngineClient`, send a valid request and two frames, emit provisional/final fake provider events, stop, and assert the client exposes the exact shared contract. Also test consent-disabled open rejection, network close mapping, backpressure, and cancel.

- [ ] **Step 2: Run and verify failure**

Run: `npm test --workspace @voice/api -- server.integration.test.ts && npm test --workspace @voice/google-transcription-engine -- CloudEngineClient.test.ts`

Expected: FAIL because server and client composition are missing.

- [ ] **Step 3: Implement production composition**

`createServer({ engineFactory, limits, logger })` is testable without credentials. `apps/api/src/index.ts` alone imports `@voice/google-transcription-engine/server`, constructs the production ADC-backed Google factory, and listens on validated `PORT`. `CloudEngineClient` is exported only from `@voice/google-transcription-engine/browser`; its `open` requires `{ cloudConsent: true, websocketUrl }`, otherwise it emits `UNAVAILABLE` without opening a socket.

- [ ] **Step 4: Run both owned packages**

Run: `npm test --workspace @voice/api && npm test --workspace @voice/google-transcription-engine && npm run typecheck --workspace @voice/api && npm run typecheck --workspace @voice/google-transcription-engine`

Expected: PASS with no network calls.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/google-transcription-engine
git commit -m "feat: expose optional google streaming engine"
```

## Task 8: Document secure local setup and hand off integration

**Files:**
- Create: `apps/api/README.md`
- Create: `apps/api/.env.example`
- Create: `packages/google-transcription-engine/README.md`

- [ ] **Step 1: Document Application Default Credentials**

Explain `gcloud auth application-default login` for local development and workload identity/service-account configuration for deployment. State that credential files, tokens, and JSON keys must not be committed or passed to the browser.

- [ ] **Step 2: Document the WebSocket protocol and limits**

Include the exact start/stop/cancel messages, 640-byte frame requirement, safe close codes, ten-minute hard limit, thirty-second idle limit, 20-session default, and non-persistence policy.

- [ ] **Step 3: Provide integration-owner notes**

List package dependencies and root scripts the integration owner must add. Provide the browser-safe cloud engine import from `@voice/google-transcription-engine/browser` and required `{ cloudConsent, websocketUrl }` options. Confirm a production web build contains no `@google-cloud/speech` module. Do not edit Agent 1 files.

- [ ] **Step 4: Run Agent 2 verification**

Run: `npm test --workspace @voice/api && npm test --workspace @voice/google-transcription-engine && npm run typecheck --workspace @voice/api && npm run typecheck --workspace @voice/google-transcription-engine`

Expected: all commands exit 0 without Google credentials.

- [ ] **Step 5: Commit**

```bash
git add apps/api/README.md apps/api/.env.example packages/google-transcription-engine/README.md
git commit -m "docs: explain secure google fallback setup"
```
