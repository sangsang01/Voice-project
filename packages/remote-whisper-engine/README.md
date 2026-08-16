# @voice/remote-whisper-engine

Browser `TranscriptionEngine` that talks to `apps/transcription-server` over
`ws://` loopback. It does not run Whisper. It does not hold React state.

Default endpoint is `ws://127.0.0.1:8787`. The web app may override that with
`VITE_TRANSCRIPTION_WS_URL`. Non-loopback URLs are rejected.

## Session flow

1. `prepare()` opens one WebSocket with subprotocol `voice-transcription.v1`.
   Connection failure throws an error that the local Whisper server is
   unavailable.
2. `open()` sends `session.start` and waits for `session.accepted`.
3. `push()` encodes each 20 ms PCM frame as a 656-byte binary message and
   returns synchronously. Credit comes back from `audio.ack`.
4. Server `engine.event` values are forwarded as the existing engine contract
   events, including provisional and final `segment.upsert`.
5. `stop()` / `cancel()` send the matching control message and wait for the
   session to end. Closing the socket does not unload the server model.

When the transcription server is not running, use **Offline local** in the UI
instead of this engine.
