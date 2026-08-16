# @voice/streaming-protocol

Shared wire types for the localhost live captions path. The browser remote
engine and the transcription server both encode and validate the same
messages. This package does not open sockets.

WebSocket subprotocol: `voice-transcription.v1`. Endpoints must use `ws:` on a
loopback host (`127.0.0.1`, `localhost`, or `::1`).

## One session per socket

A socket carries at most one listen session. The first JSON message must be
`session.start`. A second `session.start` on the same socket is rejected.
Binary PCM frames do not repeat the session id.

Client JSON:

```ts
type ClientControl =
  | { type: "session.start"; protocol: 1; request: SessionRequest }
  | { type: "session.stop"; sessionId: string }
  | { type: "session.cancel"; sessionId: string };
```

Server JSON:

```ts
type ServerMessage =
  | { type: "session.accepted"; sessionId: string; model: string; backend: NativeBackend }
  | { type: "audio.ack"; sessionId: string; throughSequence: number }
  | { type: "engine.event"; event: EngineEvent };
```

Unknown or malformed messages terminate only that session.

## PCM layout (656 bytes)

Every audio message is exactly 656 bytes, little-endian, 16 kHz, 320 samples
(20 ms), signed 16-bit PCM:

| Bytes | Content |
| --- | --- |
| 0 | protocol version `1` |
| 1 | message type `1` (PCM) |
| 2–3 | reserved, must be zero |
| 4–7 | unsigned little-endian frame sequence |
| 8–15 | little-endian Float64 `startMs` |
| 16–655 | exactly 320 signed little-endian 16-bit samples |

Wrong size, unsupported version or type, or nonzero reserved bytes are
rejected.

## ACK semantics

The server answers each accepted PCM frame with `audio.ack`.
`throughSequence` is cumulative: the client may drop every outstanding frame
whose sequence is less than or equal to that value.

The remote engine treats a duplicate or regressing ACK as a no-op (no extra
send credit). An ACK past the highest sequence the client has sent is a fatal
protocol error. Backpressure is `push()` returning `{ accepted: false }` when
the unacknowledged-frame window is full.
