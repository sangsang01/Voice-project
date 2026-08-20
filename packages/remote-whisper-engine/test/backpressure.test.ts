import { decodePcmMessage } from "@voice/streaming-protocol";
import { makePcmFrame, makeSessionRequest } from "@voice/transcription-contracts/testing";
import type { TranscriptionSession } from "@voice/transcription-contracts";
import { describe, expect, it } from "vitest";

import { RemoteWhisperEngine } from "../src/RemoteWhisperEngine.js";
import type { SocketEventMap, SocketLike } from "../src/socket.js";

class FakeSocket implements SocketLike {
  public readyState = 0;
  public bufferedAmount = 0;
  public binaryType: BinaryType = "blob";
  public readonly sent: Array<string | ArrayBuffer> = [];
  private readonly listeners: { [K in keyof SocketEventMap]: Array<(event: SocketEventMap[K]) => void> } = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  public send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = 3;
  }

  public addEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void): void {
    this.listeners[type].push(listener);
  }

  public removeEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void): void {
    this.listeners[type] = this.listeners[type].filter((candidate) => candidate !== listener) as typeof this.listeners[K];
  }

  public open(): void {
    this.readyState = 1;
    this.emit("open", {} as Event);
  }

  public emitJson(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) } as MessageEvent<string>);
  }

  public sentFrames(): ReturnType<typeof decodePcmMessage>[] {
    return this.sent.filter((value): value is ArrayBuffer => typeof value !== "string").map((value) => decodePcmMessage(value));
  }

  private emit<K extends keyof SocketEventMap>(type: K, event: SocketEventMap[K]): void {
    for (const listener of [...this.listeners[type]]) listener(event);
  }
}

async function openSession(socket: FakeSocket, maxUnacknowledgedFrames?: number): Promise<{ session: TranscriptionSession; sessionId: string }> {
  const request = makeSessionRequest(["en-US"]);
  const engine = new RemoteWhisperEngine({
    endpoint: "wss://voice.example.test/transcribe",
    socketFactory: () => socket,
    maxUnacknowledgedFrames,
  });
  await engine.prepare(request);
  const opening = engine.open(request);
  socket.open();
  socket.emitJson({ type: "session.accepted", sessionId: request.sessionId, model: "small" });
  const session = await opening;
  return { session, sessionId: request.sessionId };
}

describe("RemoteWhisperEngine backpressure", () => {
  it("accepts up to maxUnacknowledgedFrames then rejects with backpressure", async () => {
    const socket = new FakeSocket();
    const { session } = await openSession(socket, 2);

    expect(session.push(makePcmFrame(0))).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(1))).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(2))).toEqual({ accepted: false, reason: "backpressure" });
    expect(socket.sentFrames()).toHaveLength(2);
  });

  it("permits one more frame after an ACK through the lowest outstanding sequence", async () => {
    const socket = new FakeSocket();
    const { session, sessionId } = await openSession(socket, 2);

    expect(session.push(makePcmFrame(0))).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(1))).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(2))).toEqual({ accepted: false, reason: "backpressure" });

    socket.emitJson({ type: "audio.ack", sessionId, throughSequence: 0 });

    expect(session.push(makePcmFrame(2))).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(3))).toEqual({ accepted: false, reason: "backpressure" });
  });

  it("ignores duplicate and regressing ACKs without adding credit", async () => {
    const socket = new FakeSocket();
    const { session, sessionId } = await openSession(socket, 3);

    session.push(makePcmFrame(0));
    session.push(makePcmFrame(1));
    session.push(makePcmFrame(2));
    socket.emitJson({ type: "audio.ack", sessionId, throughSequence: 1 });
    socket.emitJson({ type: "audio.ack", sessionId, throughSequence: 1 });
    socket.emitJson({ type: "audio.ack", sessionId, throughSequence: 0 });

    expect(session.push(makePcmFrame(3))).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(4))).toEqual({ accepted: true });
    expect(session.push(makePcmFrame(5))).toEqual({ accepted: false, reason: "backpressure" });
  });

  it("treats an ACK beyond the highest sent sequence as a fatal protocol error", async () => {
    const socket = new FakeSocket();
    const { session, sessionId } = await openSession(socket, 2);
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));

    session.push(makePcmFrame(0));
    socket.emitJson({ type: "audio.ack", sessionId, throughSequence: 5 });

    expect(events.slice(-2)).toEqual([
      expect.objectContaining({ type: "error", code: "INTERNAL", fatal: true }),
      expect.objectContaining({ type: "state", state: "stopped" }),
    ]);
    expect(session.push(makePcmFrame(1))).toEqual({ accepted: false, reason: "backpressure" });
  });

  it("rejects push when the socket's buffered amount exceeds the limit", async () => {
    const socket = new FakeSocket();
    const { session } = await openSession(socket, 10);

    socket.bufferedAmount = 1_048_577;

    expect(session.push(makePcmFrame(0))).toEqual({ accepted: false, reason: "backpressure" });
    expect(socket.sentFrames()).toHaveLength(0);
  });

  it("consistently reports backpressure once the session is terminal", async () => {
    const socket = new FakeSocket();
    const { session } = await openSession(socket, 2);

    await session.cancel();

    expect(session.push(makePcmFrame(0))).toEqual({ accepted: false, reason: "backpressure" });
    expect(session.push(makePcmFrame(1))).toEqual({ accepted: false, reason: "backpressure" });
  });
});
