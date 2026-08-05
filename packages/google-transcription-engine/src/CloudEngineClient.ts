import type {
  EngineEvent,
  EngineEventListener,
  EngineInspection,
  PcmFrame,
  PushResult,
  SessionRequest,
  TranscriptionEngine,
  TranscriptionSession,
} from "@voice/transcription-contracts";

export interface CloudEngineClientOptions {
  cloudConsent: boolean;
  websocketUrl: string;
  /** Test seam: production code never sets this; it always constructs a real WebSocket. */
  createSocket?: (url: string) => WebSocket;
}

/** ~2s of 16kHz mono PCM16, matching the server's maxBufferedAudioMs default. */
const MAX_BUFFERED_BYTES = 64_000;

class CloudEngineSession implements TranscriptionSession {
  private readonly socket: WebSocket;
  private readonly sessionId: string;
  private readonly listeners = new Set<EngineEventListener>();
  private sequence = 0;

  constructor(socket: WebSocket, sessionId: string) {
    this.socket = socket;
    this.sessionId = sessionId;
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /** Called by the socket's own message/close handlers, set up in CloudEngineClient.open(). */
  emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  push(frame: PcmFrame): PushResult {
    if (this.socket.readyState !== WebSocket.OPEN) return { accepted: false, reason: "backpressure" };
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.emit({
        type: "warning",
        sessionId: this.sessionId,
        sequence: this.nextSequence(),
        code: "AUDIO_GAP",
        message: "Cloud socket backpressure; frame dropped",
      });
      return { accepted: false, reason: "backpressure" };
    }
    const { buffer, byteOffset, byteLength } = frame.samples;
    // PCM frames are always backed by a plain ArrayBuffer in this pipeline, never a SharedArrayBuffer.
    this.socket.send(buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer);
    return { accepted: true };
  }

  async stop(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "session.stop" }));
    }
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.addEventListener("close", () => resolve(), { once: true });
    });
  }

  async cancel(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ type: "session.cancel" }));
      } catch {
        // socket already closing; nothing to notify
      }
    }
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}

/**
 * Browser-side engine for the optional Google streaming fallback. Talks only
 * to the application WebSocket gateway (apps/api); never touches Google
 * credentials or the Google SDK, which stay server-side.
 */
export class CloudEngineClient implements TranscriptionEngine {
  private readonly options: CloudEngineClientOptions;

  constructor(options: CloudEngineClientOptions) {
    this.options = options;
  }

  async inspect(): Promise<EngineInspection> {
    return { available: typeof WebSocket !== "undefined" };
  }

  async prepare(_request: SessionRequest): Promise<void> {}

  async open(request: SessionRequest): Promise<TranscriptionSession> {
    if (!this.options.cloudConsent) {
      throw new Error("cloud transcription requires explicit user consent");
    }

    const createSocket = this.options.createSocket ?? ((url: string) => new WebSocket(url));
    const socket = createSocket(this.options.websocketUrl);
    socket.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("failed to open cloud transcription socket")),
        { once: true },
      );
    });

    socket.send(JSON.stringify({ type: "session.start", request }));

    const session = new CloudEngineSession(socket, request.sessionId);

    socket.addEventListener("message", (messageEvent: MessageEvent) => {
      try {
        session.emit(JSON.parse(String(messageEvent.data)) as EngineEvent);
      } catch {
        // A malformed server frame is dropped rather than crashing the session.
      }
    });

    socket.addEventListener("close", (closeEvent: CloseEvent) => {
      if (closeEvent.code !== 1000) {
        session.emit({
          type: "error",
          sessionId: request.sessionId,
          sequence: 0,
          code: "UNAVAILABLE",
          fatal: true,
          message: "Cloud transcription connection closed unexpectedly",
        });
      }
    });

    return session;
  }

  async dispose(): Promise<void> {}
}
