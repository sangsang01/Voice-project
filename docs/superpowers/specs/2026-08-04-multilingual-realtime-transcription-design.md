# Multilingual Realtime Transcription Design

**Date:** 2026-08-04

## Purpose

Build an open-source, portfolio-quality browser application that turns live speech into readable text while a speaker switches among as many as four selected languages. The first release preserves the spoken language; it does not translate. It demonstrates local AI inference, realtime audio handling, provider abstraction, accessibility-minded product design, and an optional low-latency cloud fallback.

## Execution assumption

The completed React, Vite, and TypeScript frontend will be placed in `apps/web` before implementation and will expose `src/App.tsx` as its composition root. Agent 1 must preserve its visual design. New behavior belongs under `apps/web/src/features/transcription`; only the minimum composition change is allowed in `src/App.tsx`.

## Goals

- Capture microphone audio in a supported desktop Chromium browser.
- Let the user select one to four unique candidate languages before starting.
- Preserve Unicode source text when languages change within a conversation.
- Display provisional text quickly and replace it with stable final segments.
- Label each segment with a selected language or `und` when confidence is insufficient.
- Provide Start, Stop, and Clear & Restart controls.
- Run a quantized multilingual Whisper model locally by default.
- Prefer WebGPU, with a WebAssembly/smaller-model degradation path.
- Cache model assets so subsequent sessions do not require another full download.
- Offer Google Cloud Speech-to-Text V1 Streaming as an explicit, opt-in fallback.
- Keep both engines behind one tested contract so the UI is provider-independent.
- Avoid storing microphone audio or transcript history on the server.

## Non-goals

- Translation, text-to-speech, accounts, transcript persistence, speaker diarization, mobile optimization, and native applications.
- Guaranteed word-level language identification. Labels describe stable speech segments.
- Silent upload of microphone audio or automatic paid fallback.
- Training or fine-tuning a speech model.

## Architecture

The repository is an npm workspace with five bounded units:

```text
apps/web
  existing frontend plus microphone and transcript wiring

apps/api
  Node WebSocket gateway; owns limits and Google credentials

packages/transcription-contracts
  frozen engine, session, audio, event, and validation contracts

packages/local-whisper-engine
  browser worker, model loading, local inference, segmentation, caching

packages/google-transcription-engine
  browser WebSocket client and server-side Google stream adapter
```

The runtime flow is:

```text
Microphone
  -> AudioWorklet
  -> 16 kHz mono signed 16-bit PCM frames
  -> TranscriptionEngine
       -> LocalWhisperEngine in a Web Worker (default)
       -> GoogleTranscriptionEngine through apps/api (opt-in)
  -> normalized EngineEvent stream
  -> reducer-owned transcript state
  -> existing frontend components
```

Local inference, audio conversion, and model loading never run on the React thread. Audio queues are bounded; an overloaded engine returns backpressure instead of allowing unbounded memory growth.

## Shared contract

`packages/transcription-contracts` is created and committed before parallel implementation. After that commit, both agents treat it as read-only. Any contract change requires both agents to stop, agree on the revision, and rebase on one integration commit.

```ts
export type CandidateLanguages = readonly [string, ...string[]];

export interface SessionRequest {
  sessionId: string;
  candidateLanguages: CandidateLanguages;
  mode: "transcribe";
  audio: {
    encoding: "pcm_s16le";
    sampleRateHz: 16000;
    channels: 1;
    frameDurationMs: 20;
  };
}

export interface PcmFrame {
  sequence: number;
  startMs: number;
  samples: Int16Array;
}

export interface TranscriptSegment {
  id: string;
  ordinal: number;
  revision: number;
  startMs: number;
  endMs: number;
  text: string;
  language: { tag: string | "und"; confidence?: number };
  isFinal: boolean;
}

export type EngineEvent =
  | { type: "state"; sessionId: string; sequence: number; state: "preparing" | "ready" | "listening" | "draining" | "stopped" }
  | { type: "segment.upsert"; sessionId: string; sequence: number; segment: TranscriptSegment }
  | { type: "segment.remove"; sessionId: string; sequence: number; segmentId: string }
  | { type: "warning"; sessionId: string; sequence: number; code: "AUDIO_GAP" | "DEGRADED_PERFORMANCE" | "LANGUAGE_UNCERTAIN"; message: string }
  | { type: "error"; sessionId: string; sequence: number; code: "UNAVAILABLE" | "UNSUPPORTED" | "INVALID_AUDIO" | "RESOURCE_EXHAUSTED" | "TIMEOUT" | "INTERNAL"; fatal: boolean; message: string; providerCode?: string };
```

Every engine implements `inspect`, `prepare`, `open`, and `dispose`. An open session implements synchronous `push`, draining `stop`, and immediate `cancel`. Events and frames are monotonically sequenced per session. Final segments are immutable. The UI rejects events from old session IDs, stale event sequences, and lower segment revisions.

## Browser and user experience

The existing frontend gains one transcription controller and adapter. The language picker accepts one to four unique BCP-47 choices. The initial portfolio fixture uses `vi-VN`, `en-US`, `es-ES`, and `zh-CN`.

- **Start:** validates languages, prepares the chosen engine, requests microphone permission, and begins a new session.
- **Stop:** stops microphone capture, drains buffered audio, finalizes remaining segments, and preserves the transcript.
- **Clear & Restart:** cancels the active session, clears all transcript segments, retains languages and cached models, creates a new session ID, and starts listening again.

Provisional segments may change. Final segments remain stable and appear in chronological order. The UI displays engine choice, preparation/download progress, listening state, detected language, and actionable warnings. Switching to cloud requires a confirmation modal that states audio will leave the device and may incur service cost.

## Local Whisper behavior

The local engine loads one quantized multilingual Whisper model in a dedicated worker. It chooses WebGPU when available and retries with the configured WebAssembly/smaller-model tier when WebGPU initialization fails. Model assets use versioned cache metadata and browser storage checks.

Whisper is window-oriented rather than a true token-streaming recognizer. The engine therefore uses short overlapping utterance windows and voice activity boundaries to create near-realtime revisions. Language scoring is restricted to the selected candidates. Hysteresis prevents rapid label flicker. A segment is labeled `und` when evidence is too weak; the application must not claim word-level language certainty.

The performance target is first provisional text within three seconds on the documented reference machine. Slower devices display `DEGRADED_PERFORMANCE` while continuing if queues remain bounded.

## Google fallback behavior

The cloud engine sends the same 16 kHz mono PCM frames over an origin-checked application WebSocket to `apps/api`. The API keeps Google Application Default Credentials on the server and opens a V1 `StreamingRecognize` call. The first selected language is the primary language and the remaining one to three values are `alternativeLanguageCodes`. This MVP gateway is for local development or a trusted deployment; a public deployment must add its own user authentication before enabling the paid fallback.

The server enforces a ten-minute maximum session, a thirty-second speech/audio idle timeout, an input-frame size limit, ordered frame sequences, and bounded buffering. Browser disconnect, Stop, timeout, Google error, or process shutdown closes the Google stream exactly once. Provider responses are normalized to the shared event contract; Google-specific errors never leak credentials or raw internal details.

## Privacy and cost controls

- Local is the default engine.
- Cloud use is opt-in per browser profile and visible during the session.
- API credentials and Google SDK objects never enter browser bundles.
- Neither engine persists audio; the API does not write audio or transcripts to disk.
- The API rejects sessions above configured concurrency and duration limits.
- Stop and disconnect immediately end billable cloud streaming after buffered audio drains.
- Logs contain session IDs, timings, engine state, and error codes, but no transcript text or audio.

## Error handling

- Permission denial leaves the app stopped and explains how to retry.
- Missing microphone, device removal, audio gaps, and resampler failure produce standardized events.
- Worker crashes terminate the local session without accepting more frames.
- WebGPU failure triggers the declared local degradation path once.
- Model download or storage failure offers retry or explicit cloud consent.
- When an engine queue reaches its fixed capacity, the controller discards the oldest unprocessed PCM frame and emits `AUDIO_GAP`; it never removes an already-emitted final transcript segment.
- Cloud authorization, quota, timeout, and provider errors map to safe shared error codes.
- Clear & Restart invalidates the old session before clearing state so late events cannot repopulate the transcript.

## Testing and evaluation

- Unit tests cover contract validation, reducer ordering, lifecycle transitions, resampling, bounded queues, cache versioning, language hysteresis, limits, and provider error mapping.
- A shared conformance suite runs unchanged against fake, local, and cloud engine factories.
- Component tests wire the existing controls and language picker to a fake engine.
- Chromium end-to-end tests use fake microphone audio and cover Start, Stop, rapid restart, permission denial, worker failure, and WebGPU-disabled behavior.
- API integration tests use a mock Google streaming client and a real local WebSocket server.
- A non-blocking benchmark uses licensed fixture recordings for the four-language phrase and reports first-segment latency, realtime factor, word/character error rate, language-segment accuracy, peak memory, and dropped audio.

## Two-agent implementation boundary

### Agent 1: shared bootstrap, browser wiring, and local engine

Agent 1 first creates the workspace and frozen contract commit. After Agent 2 rebases on that commit, Agent 1 exclusively owns `apps/web/**` and `packages/local-whisper-engine/**`. Agent 1 preserves the existing frontend and adds its wiring under `apps/web/src/features/transcription/**`.

### Agent 2: API and Google engine

After the contract commit, Agent 2 exclusively owns `apps/api/**` and `packages/google-transcription-engine/**`. Agent 2 consumes the contract package without changing it and provides a contract-conforming cloud engine factory.

### Integration owner

The human coordinator owns root workspace files after bootstrap, contract changes, lockfile conflict resolution, branch integration, and the final full-suite run. Agent 1 makes the minimal final `src/App.tsx` composition change because Agent 1 owns the frontend.

## Acceptance criteria

- Both engines pass the same lifecycle and event conformance suite.
- The existing frontend design remains intact and all three controls are wired.
- One to four languages are validated and passed to both engines.
- The transcript preserves Vietnamese, English, Spanish, and Chinese source text.
- Partial revisions never duplicate finalized text or reorder segments.
- Local transcription works without API credentials after assets are cached.
- Cloud transcription cannot start without explicit consent and server credentials.
- Stop, cancel, restart, disconnect, and timeout release microphone, worker, WebSocket, and Google stream resources.
- No audio or transcript content is persisted or written to logs.
- README documentation explains local requirements, optional Google setup, limitations, privacy, and benchmark results.
