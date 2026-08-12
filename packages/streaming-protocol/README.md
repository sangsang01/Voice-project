# @voice/streaming-protocol

Shared wire types and codecs for the `voice-transcription.v1` WebSocket
subprotocol used by `@voice/remote-whisper-engine` and
`@voice/transcription-server`.

Production transports use `wss:`. Unencrypted `ws:` is for loopback development
only.

## Invariants

- **One session per socket.** Binary PCM messages do not carry a session ID. A
  second `session.start` while a session is active is a protocol error.
- **656-byte PCM frames only.** Every binary audio message is exactly
  `PCM_MESSAGE_BYTES` (656) bytes. Other sizes are rejected.
- **ACK semantics.** Servers emit `{ type: "audio.ack"; sessionId; throughSequence }`.
  Clients release credit for every outstanding sequence `<= throughSequence`.
  Duplicate or regressing ACKs are no-ops; an ACK beyond the highest sent
  sequence is fatal.

## 656-byte PCM layout

Little-endian throughout:

| Bytes | Field |
| ---: | --- |
| 0 | Protocol version (`1`) |
| 1 | Message type (`1` = PCM) |
| 2–3 | Reserved; must be `0` |
| 4–7 | `uint32` frame `sequence` |
| 8–15 | `float64` `startMs` |
| 16–655 | Exactly 320 signed `int16` PCM samples (16 kHz mono, 20 ms) |

`encodePcmMessage` / `decodePcmMessage` reject wrong sizes, unsupported
versions/types, and nonzero reserved bytes.

## Control messages

```ts
type ClientControl =
  | { type: "session.start"; protocol: 1; request: SessionRequest }
  | { type: "session.stop"; sessionId: string }
  | { type: "session.cancel"; sessionId: string };

type ServerMessage =
  | { type: "session.accepted"; sessionId: string; model: string }
  | { type: "audio.ack"; sessionId: string; throughSequence: number }
  | { type: "engine.event"; event: EngineEvent };
```

JSON messages are validated in `validation.ts`. Unknown or malformed control
payloads should terminate only the affected session with a normalized fatal
error at the transport boundary.

## Build

```bash
npm run build --workspace @voice/streaming-protocol
```

`dist/` is generated TypeScript output consumed by other workspaces. Root
`npm run build` compiles this package immediately after
`@voice/transcription-contracts`.
