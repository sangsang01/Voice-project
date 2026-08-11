import { decodePcmMessage } from "@voice/streaming-protocol";
import { describeEngineContract, makePcmFrame, makeSessionRequest } from "@voice/transcription-contracts/testing";

import { RemoteWhisperEngine } from "../src/RemoteWhisperEngine.js";
import type { SocketEventMap, SocketLike } from "../src/socket.js";

class ContractSocket implements SocketLike {
  public readyState = 0;
  public bufferedAmount = 0;
  public binaryType: BinaryType = "blob";
  private sequence = 1;
  private readonly listeners: { [K in keyof SocketEventMap]: Array<(event: SocketEventMap[K]) => void> } = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  public send(data: string | ArrayBuffer): void {
    if (typeof data === "string") {
      this.handleControl(JSON.parse(data) as { type?: string; request?: { sessionId: string }; sessionId?: string });
      return;
    }
    const frame = decodePcmMessage(data);
    this.emitJson({
      type: "audio.ack",
      sessionId: "fake-transcription-session",
      throughSequence: frame.sequence,
    });
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

  private handleControl(message: { type?: string; request?: { sessionId: string }; sessionId?: string }): void {
    if (message.type === "session.start" && message.request) {
      this.emitJson({ type: "session.accepted", sessionId: message.request.sessionId, model: "small" });
      this.emitJson({
        type: "engine.event",
        event: { type: "state", sessionId: message.request.sessionId, sequence: this.sequence++, state: "listening" },
      });
      return;
    }
    if (message.type === "session.stop" && message.sessionId) {
      this.emitJson({
        type: "engine.event",
        event: { type: "state", sessionId: message.sessionId, sequence: this.sequence++, state: "draining" },
      });
      this.emitJson({
        type: "engine.event",
        event: {
          type: "segment.upsert",
          sessionId: message.sessionId,
          sequence: this.sequence++,
          segment: {
            id: `${message.sessionId}:final`,
            ordinal: 0,
            revision: 1,
            startMs: 0,
            endMs: 20,
            text: "hello",
            language: { tag: "en-US" },
            isFinal: true,
          },
        },
      });
      this.emitJson({
        type: "engine.event",
        event: { type: "state", sessionId: message.sessionId, sequence: this.sequence++, state: "stopped" },
      });
      return;
    }
    if (message.type === "session.cancel" && message.sessionId) {
      this.emitJson({
        type: "engine.event",
        event: { type: "state", sessionId: message.sessionId, sequence: this.sequence++, state: "stopped" },
      });
    }
  }

  private emitJson(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) } as MessageEvent<string>);
  }

  private emit<K extends keyof SocketEventMap>(type: K, event: SocketEventMap[K]): void {
    for (const listener of [...this.listeners[type]]) listener(event);
  }
}

describeEngineContract("remote whisper", () => {
  const socket = new ContractSocket();
  const engine = new RemoteWhisperEngine({
    endpoint: "wss://voice.example.test/transcribe",
    socketFactory: () => socket,
  });
  queueMicrotask(() => socket.open());
  return engine;
}, {
  request: makeSessionRequest(["en-US"]),
  frame: makePcmFrame(0),
});
