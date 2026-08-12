# @voice/remote-whisper-engine

Browser `TranscriptionEngine` for **Online real-time** mode: microphone PCM
frames travel over `voice-transcription.v1` WebSocket to the transcription
server, and provisional/final `EngineEvent`s flow back into the existing UI
reducer.

This package owns the socket adapter only. It does not hold React/UI state.

## Session flow

1. `prepare()` opens the socket (subprotocol `voice-transcription.v1`), attaches
   the bearer token when configured, and waits until the connection is ready.
2. `open()` sends `session.start` and waits for `session.accepted`. One socket
   owns at most one active session.
3. `push()` validates each 20 ms / 320-sample PCM frame, encodes it with
   `encodePcmMessage` (656 bytes), and returns synchronously. Backpressure is
   reported when the unacknowledged-frame queue is full or
   `bufferedAmount > 1_048_576`.
4. `audio.ack` with `throughSequence` releases credit for sequences
   `<= throughSequence`. Duplicate/regressing ACKs are ignored; ACK beyond the
   highest sent sequence fails the session fatally.
5. `stop()` / `cancel()` send the matching control message. Socket loss emits one
   fatal `UNAVAILABLE` and preserves already-final transcript segments.

## Configuration

Constructed by the web app when `VITE_TRANSCRIPTION_WS_URL` is set:

| Option | Purpose |
| --- | --- |
| `endpoint` | `wss:` URL in production; `ws://127.0.0.1:...` only for loopback development |
| `tokenProvider` | Optional short-lived bearer token supplier |
| `maxUnacknowledgedFrames` | Client backpressure window |
| `socketFactory` | Test injection seam |

## Tests

Contract and backpressure suites use an injected fake socket. Ordinary CI does
not require a live server, GPU, or native binary.

```bash
npm test --workspace @voice/remote-whisper-engine
```

## Build

```bash
npm run build --workspace @voice/remote-whisper-engine
```

Root `npm run build` compiles this package after `@voice/streaming-protocol` and
`@voice/local-whisper-engine`.
