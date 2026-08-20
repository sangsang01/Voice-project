import { makePcmFrame, makeSessionRequest } from "@voice/transcription-contracts/testing";
import { describe, expect, it } from "vitest";

import { RemoteWhisperEngine } from "../src/RemoteWhisperEngine.js";
import type { SocketEventMap, SocketLike } from "../src/socket.js";

class FakeSocket implements SocketLike {
  public readyState = 0;
  public bufferedAmount = 0;
  public binaryType: BinaryType = "blob";
  public readonly sent: Array<string | ArrayBuffer> = [];
  public closeCalls = 0;
  public closeArgs: Array<[number | undefined, string | undefined]> = [];
  private readonly listeners: { [K in keyof SocketEventMap]: Array<(event: SocketEventMap[K]) => void> } = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  public send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.closeCalls += 1;
    this.closeArgs.push([code, reason]);
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

  public emitText(data: string): void {
    this.emit("message", { data } as MessageEvent<string>);
  }

  public closeFromServer(): void {
    this.readyState = 3;
    this.emit("close", { code: 1006, reason: "lost", wasClean: false } as CloseEvent);
  }

  public sentJson(): unknown[] {
    return this.sent.filter((value): value is string => typeof value === "string").map((value) => JSON.parse(value) as unknown);
  }

  private emit<K extends keyof SocketEventMap>(type: K, event: SocketEventMap[K]): void {
    for (const listener of [...this.listeners[type]]) listener(event);
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("RemoteWhisperEngine", () => {
  it("opens a prepared remote session after the server accepts it", async () => {
    const request = makeSessionRequest(["en-US"]);
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    const protocols: readonly string[][] = [];
    const engine = new RemoteWhisperEngine({
      endpoint: "wss://voice.example.test/transcribe",
      tokenProvider: () => "secret token",
      socketFactory: (url, requestedProtocols) => {
        urls.push(url);
        protocols.push(requestedProtocols);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    await engine.prepare(request);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.binaryType).toBe("arraybuffer");
    expect(protocols).toEqual([["voice-transcription.v1"]]);
    expect(urls[0]).toBe("wss://voice.example.test/transcribe?access_token=secret+token");

    const opening = engine.open(request);
    sockets[0]!.open();
    sockets[0]!.emitJson({ type: "session.accepted", sessionId: request.sessionId, model: "small" });
    const session = await opening;

    expect(session).toBeDefined();
    expect(sockets[0]!.sentJson()).toContainEqual({ type: "session.start", protocol: 1, request });
  });

  it("reports insecure non-loopback endpoints as unavailable", async () => {
    await expect(new RemoteWhisperEngine({ endpoint: "ws://example.com/transcribe" }).inspect()).resolves.toEqual({
      available: false,
      reason: expect.stringMatching(/secure|wss/i),
    });
    await expect(new RemoteWhisperEngine({ endpoint: "ws://localhost:8787/transcribe" }).inspect()).resolves.toEqual({
      available: true,
    });
    await expect(new RemoteWhisperEngine({ endpoint: "ws://127.0.0.1:8787/transcribe" }).inspect()).resolves.toEqual({
      available: true,
    });
    await expect(new RemoteWhisperEngine({ endpoint: "ws://[::1]:8787/transcribe" }).inspect()).resolves.toEqual({
      available: true,
    });
  });

  it("fails open before prepare", async () => {
    const engine = new RemoteWhisperEngine({ endpoint: "wss://voice.example.test/transcribe" });
    await expect(engine.open(makeSessionRequest(["en-US"]))).rejects.toThrow(/prepared/i);
  });

  it("rejects opening and closes the socket when the server sends an invalid message before acceptance", async () => {
    const request = makeSessionRequest(["en-US"]);
    const socket = new FakeSocket();
    const engine = new RemoteWhisperEngine({
      endpoint: "wss://voice.example.test/transcribe",
      socketFactory: () => socket,
    });
    await engine.prepare(request);

    const opening = engine.open(request);
    socket.open();
    await flush();
    socket.emitText("{");

    await expect(opening).rejects.toThrow(/message|json|control/i);
    expect(socket.closeCalls).toBe(1);
  });

  it("delivers a matching server event with sequence 0 after synthetic listening", async () => {
    const request = makeSessionRequest(["en-US"]);
    const socket = new FakeSocket();
    const engine = new RemoteWhisperEngine({
      endpoint: "wss://voice.example.test/transcribe",
      socketFactory: () => socket,
    });
    await engine.prepare(request);
    const opening = engine.open(request);
    socket.open();
    socket.emitJson({ type: "session.accepted", sessionId: request.sessionId, model: "small" });
    const session = await opening;
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));

    socket.emitJson({
      type: "engine.event",
      event: { type: "state", sessionId: request.sessionId, sequence: 0, state: "draining" },
    });

    expect(events).toEqual([
      expect.objectContaining({ type: "state", state: "listening" }),
      expect.objectContaining({ type: "state", sequence: 0, state: "draining" }),
    ]);
  });

  it("rejects prepare while a session is opening or active", async () => {
    const request = makeSessionRequest(["en-US"]);
    const socket = new FakeSocket();
    const engine = new RemoteWhisperEngine({
      endpoint: "wss://voice.example.test/transcribe",
      socketFactory: () => socket,
    });
    await engine.prepare(request);
    const opening = engine.open(request);

    await expect(engine.prepare({ ...request, sessionId: "replacement-session" })).rejects.toThrow(/active|opening/i);
    socket.open();
    socket.emitJson({ type: "session.accepted", sessionId: request.sessionId, model: "small" });
    await opening;

    await expect(engine.prepare({ ...request, sessionId: "replacement-session" })).rejects.toThrow(/active|opening/i);
  });

  it("coalesces same-session concurrent prepare and rejects different-session concurrent prepare", async () => {
    const request = makeSessionRequest(["en-US"]);
    const replacement = { ...request, sessionId: "replacement-session" };
    const sockets: FakeSocket[] = [];
    const engine = new RemoteWhisperEngine({
      endpoint: "wss://voice.example.test/transcribe",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const preparing = engine.prepare(request);
    const sameSessionPrepare = engine.prepare(request);
    const differentSessionPrepare = engine.prepare(replacement);

    await expect(sameSessionPrepare).resolves.toBeUndefined();
    await expect(differentSessionPrepare).rejects.toThrow(/prepar/i);
    await expect(preparing).resolves.toBeUndefined();
    expect(sockets).toHaveLength(1);

    const opening = engine.open(request);
    sockets[0]!.open();
    sockets[0]!.emitJson({ type: "session.accepted", sessionId: request.sessionId, model: "small" });
    await expect(opening).resolves.toBeDefined();
  });

  it("does not install a socket when disposed during in-flight prepare", async () => {
    const request = makeSessionRequest(["en-US"]);
    const token = deferred<string>();
    const sockets: FakeSocket[] = [];
    const engine = new RemoteWhisperEngine({
      endpoint: "wss://voice.example.test/transcribe",
      tokenProvider: () => token.promise,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const preparing = engine.prepare(request);
    await flush();
    await engine.dispose();
    token.resolve("late-token");

    await expect(preparing).rejects.toThrow(/disposed/i);
    expect(sockets.every((socket) => socket.closeCalls === 1)).toBe(true);
    await expect(engine.open(request)).rejects.toThrow(/disposed/i);
  });

  it("rejects an interleaved prepare that resumes after open starts", async () => {
    const request = makeSessionRequest(["en-US"]);
    const replacement = { ...request, sessionId: "replacement-session" };
    const sockets: FakeSocket[] = [];
    const engine = new RemoteWhisperEngine({
      endpoint: "wss://voice.example.test/transcribe",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await engine.prepare(request);

    const preparingReplacement = engine.prepare(replacement);
    const opening = engine.open(request);

    await expect(preparingReplacement).rejects.toThrow(/active|opening/i);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closeCalls).toBe(0);

    sockets[0]!.open();
    sockets[0]!.emitJson({ type: "session.accepted", sessionId: request.sessionId, model: "small" });
    await expect(opening).resolves.toBeDefined();
  });

  it("sends session.cancel once and emits stopped when cancelled", async () => {
    const request = makeSessionRequest(["en-US"]);
    const socket = new FakeSocket();
    const engine = new RemoteWhisperEngine({
      endpoint: "wss://voice.example.test/transcribe",
      socketFactory: () => socket,
    });
    await engine.prepare(request);
    const opening = engine.open(request);
    socket.open();
    socket.emitJson({ type: "session.accepted", sessionId: request.sessionId, model: "small" });
    const session = await opening;
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));

    await session.cancel();
    await session.cancel();

    expect(socket.sentJson().filter((message) => (message as { type?: string }).type === "session.cancel")).toEqual([
      { type: "session.cancel", sessionId: request.sessionId },
    ]);
    expect(events).toEqual([
      expect.objectContaining({ type: "state", state: "listening" }),
      expect.objectContaining({ type: "state", state: "stopped" }),
    ]);
  });

  it("emits one fatal unavailable error followed by stopped when the socket closes during a session", async () => {
    const request = makeSessionRequest(["en-US"]);
    const socket = new FakeSocket();
    const engine = new RemoteWhisperEngine({
      endpoint: "wss://voice.example.test/transcribe",
      socketFactory: () => socket,
    });
    await engine.prepare(request);
    const opening = engine.open(request);
    socket.open();
    socket.emitJson({ type: "session.accepted", sessionId: request.sessionId, model: "small" });
    const session = await opening;
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));

    socket.closeFromServer();
    socket.closeFromServer();
    await flush();

    expect(events.slice(-2)).toEqual([
      expect.objectContaining({ type: "error", code: "UNAVAILABLE", fatal: true }),
      expect.objectContaining({ type: "state", state: "stopped" }),
    ]);
    expect(events.filter((event) => (event as { type?: string }).type === "error")).toHaveLength(1);
    expect(session.push(makePcmFrame(0))).toEqual({ accepted: false, reason: "backpressure" });
  });

  it("isolates listener exceptions and filters nonmatching-session events", async () => {
    const request = makeSessionRequest(["en-US"]);
    const socket = new FakeSocket();
    const engine = new RemoteWhisperEngine({
      endpoint: "wss://voice.example.test/transcribe",
      socketFactory: () => socket,
    });
    await engine.prepare(request);
    const opening = engine.open(request);
    socket.open();
    socket.emitJson({ type: "session.accepted", sessionId: request.sessionId, model: "small" });
    const session = await opening;
    const throwingEvents: unknown[] = [];
    const observed: unknown[] = [];
    session.subscribe((event) => {
      throwingEvents.push(event);
      throw new Error("listener failed");
    });
    session.subscribe((event) => observed.push(event));

    expect(() => {
      socket.emitJson({
        type: "engine.event",
        event: { type: "state", sessionId: "other-session", sequence: 0, state: "draining" },
      });
      socket.emitJson({
        type: "engine.event",
        event: { type: "state", sessionId: request.sessionId, sequence: 0, state: "draining" },
      });
    }).not.toThrow();

    expect(throwingEvents).toEqual([
      expect.objectContaining({ type: "state", state: "listening" }),
      expect.objectContaining({ type: "state", state: "draining" }),
    ]);
    expect(observed).toEqual([
      expect.objectContaining({ type: "state", state: "draining" }),
    ]);
  });
});
