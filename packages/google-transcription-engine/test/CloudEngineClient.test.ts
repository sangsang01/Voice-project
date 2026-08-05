import { describe, expect, it } from "vitest";
import { CloudEngineClient } from "../src/CloudEngineClient";
import { FakeWebSocket } from "./helpers/fakeWebSocket";
import type { EngineEvent, SessionRequest } from "@voice/transcription-contracts";

const request: SessionRequest = {
  sessionId: "session-1",
  candidateLanguages: ["vi-VN", "en-US"],
  mode: "transcribe",
  audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
};

function makeClient(cloudConsent = true) {
  let createdSocket: FakeWebSocket | undefined;
  const client = new CloudEngineClient({
    cloudConsent,
    websocketUrl: "wss://api.example.com/transcribe",
    createSocket: (url) => {
      createdSocket = new FakeWebSocket(url);
      return createdSocket as unknown as WebSocket;
    },
  });
  return { client, getSocket: () => createdSocket! };
}

describe("CloudEngineClient", () => {
  it("rejects open() without consent and never constructs a socket", async () => {
    let socketConstructed = false;
    const client = new CloudEngineClient({
      cloudConsent: false,
      websocketUrl: "wss://api.example.com/transcribe",
      createSocket: (url) => {
        socketConstructed = true;
        return new FakeWebSocket(url) as unknown as WebSocket;
      },
    });

    await expect(client.open(request)).rejects.toThrow("cloud transcription requires explicit user consent");
    expect(socketConstructed).toBe(false);
  });

  it("opens the socket, sends session.start, and exposes a TranscriptionSession implementing push/stop/cancel/subscribe", async () => {
    const { client, getSocket } = makeClient();
    const openPromise = client.open(request);
    getSocket().simulateOpen();
    const session = await openPromise;

    expect(getSocket().sent).toEqual([JSON.stringify({ type: "session.start", request })]);
    expect(typeof session.push).toBe("function");
    expect(typeof session.stop).toBe("function");
    expect(typeof session.cancel).toBe("function");
    expect(typeof session.subscribe).toBe("function");
  });

  it("forwards two PCM frames as binary sends and reports them accepted", async () => {
    const { client, getSocket } = makeClient();
    const openPromise = client.open(request);
    getSocket().simulateOpen();
    const session = await openPromise;

    expect(session.push({ sequence: 0, startMs: 0, samples: Int16Array.from([1, 2, 3, 4]) })).toEqual({
      accepted: true,
    });
    expect(session.push({ sequence: 1, startMs: 20, samples: Int16Array.from([5, 6, 7, 8]) })).toEqual({
      accepted: true,
    });

    const binarySends = getSocket().sent.filter((chunk) => chunk instanceof ArrayBuffer);
    expect(binarySends).toHaveLength(2);
  });

  it("relays provisional and final events emitted by the server to subscribers", async () => {
    const { client, getSocket } = makeClient();
    const events: EngineEvent[] = [];
    const openPromise = client.open(request);
    getSocket().simulateOpen();
    const session = await openPromise;
    session.subscribe((event) => events.push(event));

    const provisional: EngineEvent = {
      type: "segment.upsert",
      sessionId: "session-1",
      sequence: 1,
      segment: {
        id: "google-1",
        ordinal: 1,
        revision: 1,
        startMs: 0,
        endMs: 500,
        text: "Xin",
        language: { tag: "vi-VN" },
        isFinal: false,
      },
    };
    const final: EngineEvent = { ...provisional, sequence: 2, segment: { ...provisional.segment, revision: 2, text: "Xin chào", isFinal: true } };

    getSocket().simulateMessage(provisional);
    getSocket().simulateMessage(final);

    expect(events).toEqual([provisional, final]);
  });

  it("stop() sends session.stop and resolves once the server closes the socket", async () => {
    const { client, getSocket } = makeClient();
    const openPromise = client.open(request);
    getSocket().simulateOpen();
    const session = await openPromise;

    const stopPromise = session.stop();
    expect(getSocket().sent).toContain(JSON.stringify({ type: "session.stop" }));
    getSocket().simulateClose(1000);
    await expect(stopPromise).resolves.toBeUndefined();
  });

  it("cancel() sends session.cancel and closes immediately without waiting", async () => {
    const { client, getSocket } = makeClient();
    const openPromise = client.open(request);
    getSocket().simulateOpen();
    const session = await openPromise;

    await session.cancel();

    expect(getSocket().sent).toContain(JSON.stringify({ type: "session.cancel" }));
    expect(getSocket().readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("maps an unexpected close (non-1000) to a fatal UNAVAILABLE error event", async () => {
    const { client, getSocket } = makeClient();
    const events: EngineEvent[] = [];
    const openPromise = client.open(request);
    getSocket().simulateOpen();
    const session = await openPromise;
    session.subscribe((event) => events.push(event));

    getSocket().simulateClose(1011, "server error");

    expect(events).toEqual([
      {
        type: "error",
        sessionId: "session-1",
        sequence: 0,
        code: "UNAVAILABLE",
        fatal: true,
        message: "Cloud transcription connection closed unexpectedly",
      },
    ]);
  });

  it("does not emit an error event for a normal (1000) close", async () => {
    const { client, getSocket } = makeClient();
    const events: EngineEvent[] = [];
    const openPromise = client.open(request);
    getSocket().simulateOpen();
    const session = await openPromise;
    session.subscribe((event) => events.push(event));

    getSocket().simulateClose(1000, "");

    expect(events).toEqual([]);
  });

  it("drops a frame and emits AUDIO_GAP when the socket is backed up (backpressure)", async () => {
    const { client, getSocket } = makeClient();
    const events: EngineEvent[] = [];
    const openPromise = client.open(request);
    getSocket().simulateOpen();
    const session = await openPromise;
    session.subscribe((event) => events.push(event));

    getSocket().bufferedAmount = 1_000_000;
    const result = session.push({ sequence: 0, startMs: 0, samples: Int16Array.from([1, 2]) });

    expect(result).toEqual({ accepted: false, reason: "backpressure" });
    expect(events).toEqual([
      {
        type: "warning",
        sessionId: "session-1",
        sequence: 1,
        code: "AUDIO_GAP",
        message: "Cloud socket backpressure; frame dropped",
      },
    ]);
    expect(getSocket().sent.filter((chunk) => chunk instanceof ArrayBuffer)).toHaveLength(0);
  });
});
