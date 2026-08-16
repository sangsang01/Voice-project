import { encodePcmMessage } from "@voice/streaming-protocol";
import { makePcmFrame } from "@voice/transcription-contracts/testing";
import { describe, expect, it } from "vitest";
import { RemoteWhisperEngine } from "../src/index.js";
import { FakeSocket } from "./fakeSocket.js";

const request = {
  sessionId: "session-1",
  candidateLanguages: ["en-US"],
  mode: "transcribe",
  audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
} as const;

function createOpeningFactory(sockets: FakeSocket[]) {
  return (url: string, protocols: readonly string[]) => {
    const socket = new FakeSocket(url, protocols);
    sockets.push(socket);
    const originalSend = socket.send.bind(socket);
    socket.send = (data: string | ArrayBuffer) => {
      originalSend(data);
      if (typeof data !== "string") return;
      const message = JSON.parse(data) as { type?: string; sessionId?: string };
      if (message.type === "session.cancel" && message.sessionId) {
        queueMicrotask(() => {
          socket.emitJson({
            type: "engine.event",
            event: {
              type: "state",
              sessionId: message.sessionId,
              sequence: 0,
              state: "stopped",
            },
          });
        });
      }
    };
    queueMicrotask(() => socket.open());
    return socket;
  };
}

async function openBackpressureSession() {
  const sockets: FakeSocket[] = [];
  const engine = new RemoteWhisperEngine({
    endpoint: "ws://127.0.0.1:8787",
    socketFactory: createOpeningFactory(sockets),
    maxUnacknowledgedFrames: 2,
  });
  await engine.prepare(request);
  const opening = engine.open(request);
  sockets[0]!.emitJson({
    type: "session.accepted",
    sessionId: request.sessionId,
    model: "small",
    backend: "cpu",
  });
  const session = await opening;
  return { engine, session, socket: sockets[0]! };
}

function sentPcm(socket: FakeSocket): ArrayBuffer[] {
  return socket.sent.filter((value): value is ArrayBuffer => value instanceof ArrayBuffer);
}

describe("RemoteWhisperEngine backpressure", () => {
  it("accepts two frames then rejects with backpressure", async () => {
    const { engine, session, socket } = await openBackpressureSession();
    const first = makePcmFrame(0);
    const second = makePcmFrame(1);

    expect(session.push(first)).toEqual({ accepted: true });
    expect(session.push(second)).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(2))).toEqual({ accepted: false, reason: "backpressure" });

    const pcm = sentPcm(socket);
    expect(pcm).toHaveLength(2);
    expect(pcm[0]!.byteLength).toBe(656);
    expect(pcm[1]!.byteLength).toBe(656);
    expect(new Uint8Array(pcm[0]!)).toEqual(new Uint8Array(encodePcmMessage(first)));
    expect(new Uint8Array(pcm[1]!)).toEqual(new Uint8Array(encodePcmMessage(second)));

    await engine.dispose();
  });

  it("credits one frame after audio.ack throughSequence 0", async () => {
    const { engine, session, socket } = await openBackpressureSession();
    expect(session.push(makePcmFrame(0))).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(1))).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(2))).toEqual({ accepted: false, reason: "backpressure" });

    socket.emitJson({
      type: "audio.ack",
      sessionId: request.sessionId,
      throughSequence: 0,
    });

    const third = makePcmFrame(2);
    expect(session.push(third)).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(3))).toEqual({ accepted: false, reason: "backpressure" });

    const pcm = sentPcm(socket);
    expect(pcm).toHaveLength(3);
    expect(pcm[2]!.byteLength).toBe(656);
    expect(new Uint8Array(pcm[2]!)).toEqual(new Uint8Array(encodePcmMessage(third)));

    await engine.dispose();
  });

  it("does not add credit for duplicate or regressing ACKs", async () => {
    const { engine, session, socket } = await openBackpressureSession();
    expect(session.push(makePcmFrame(0))).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(1))).toEqual({ accepted: true });

    socket.emitJson({
      type: "audio.ack",
      sessionId: request.sessionId,
      throughSequence: 0,
    });
    socket.emitJson({
      type: "audio.ack",
      sessionId: request.sessionId,
      throughSequence: 0,
    });
    socket.emitJson({
      type: "audio.ack",
      sessionId: request.sessionId,
      throughSequence: 0,
    });

    expect(session.push(makePcmFrame(2))).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(3))).toEqual({ accepted: false, reason: "backpressure" });

    await engine.dispose();
  });

  it("emits a fatal protocol error when ACK is beyond the highest sent sequence", async () => {
    const { engine, session, socket } = await openBackpressureSession();
    expect(session.push(makePcmFrame(0))).toEqual({ accepted: true });

    const events: Array<{ type: string; code?: string; state?: string; fatal?: boolean }> = [];
    session.subscribe((event) =>
      events.push(event as { type: string; code?: string; state?: string; fatal?: boolean }),
    );

    socket.emitJson({
      type: "audio.ack",
      sessionId: request.sessionId,
      throughSequence: 5,
    });

    expect(events.some((event) => event.type === "error" && event.code === "UNSUPPORTED" && event.fatal === true)).toBe(
      true,
    );
    expect(events.some((event) => event.type === "state" && event.state === "stopped")).toBe(true);
    expect(session.push(makePcmFrame(1))).toEqual({ accepted: false, reason: "backpressure" });

    await engine.dispose();
  });

  it("rejects push when socket.bufferedAmount exceeds 1_048_576", async () => {
    const { engine, session, socket } = await openBackpressureSession();
    socket.bufferedAmount = 1_048_577;

    expect(session.push(makePcmFrame(0))).toEqual({ accepted: false, reason: "backpressure" });
    expect(sentPcm(socket)).toHaveLength(0);

    await engine.dispose();
  });

  it("rejects push with backpressure after stop", async () => {
    const { engine, session, socket } = await openBackpressureSession();
    const stopping = session.stop();

    expect(session.push(makePcmFrame(0))).toEqual({ accepted: false, reason: "backpressure" });
    expect(sentPcm(socket)).toHaveLength(0);

    socket.emitJson({
      type: "engine.event",
      event: {
        type: "state",
        sessionId: request.sessionId,
        sequence: 0,
        state: "stopped",
      },
    });
    await stopping;
    await engine.dispose();
  });
});
