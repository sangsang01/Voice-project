import type {
  EngineCapabilities,
  EngineEvent,
  EngineEventListener,
  EngineSession,
  PcmFrame,
  SessionRequest,
  TranscriptionEngine,
} from "@voice/transcription-contracts";

export interface CloudEngineClientOptions {
  cloudConsent: boolean;
  websocketUrl: string;
  /** Test seam: production code never sets this; it always constructs a real WebSocket. */
  createSocket?: (url: string) => WebSocket;
}

/** ~2s of 16kHz mono PCM16, matching the server's maxBufferedAudioMs default. */
const MAX_BUFFERED_BYTES = 64_000;

class CloudEngineSession implements EngineSession {
  private readonly socket: WebSocket;
  private readonly sessionId: string;
  private readonly onEvent: EngineEventListener;
  private sequence = 0;

  constructor(socket: WebSocket, sessionId: string, onEvent: EngineEventListener) {
    this.socket = socket;
    this.sessionId = sessionId;
    this.onEvent = onEvent;
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  push(frame: PcmFrame): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.onEvent({
        type: "warning",
        sessionId: this.sessionId,
        sequence: this.nextSequence(),
        code: "AUDIO_GAP",
        message: "Cloud socket backpressure; frame dropped",
      });
      return;
    }
    const { buffer, byteOffset, byteLength } = frame.samples;
    this.socket.send(buffer.slice(byteOffset, byteOffset + byteLength));
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

  cancel(): void {
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

  inspect(): EngineCapabilities {
    return { supported: typeof WebSocket !== "undefined" };
  }

  async prepare(): Promise<void> {}

  async open(request: SessionRequest, onEvent: EngineEventListener): Promise<EngineSession> {
    if (!this.options.cloudConsent) {
      onEvent({
        type: "error",
        sessionId: request.sessionId,
        sequence: 1,
        code: "UNAVAILABLE",
        fatal: true,
        message: "Cloud transcription requires explicit user consent",
      });
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

    socket.addEventListener("message", (messageEvent: MessageEvent) => {
      try {
        onEvent(JSON.parse(String(messageEvent.data)) as EngineEvent);
      } catch {
        // A malformed server frame is dropped rather than crashing the session.
      }
    });

    socket.addEventListener("close", (closeEvent: CloseEvent) => {
      if (closeEvent.code !== 1000) {
        onEvent({
          type: "error",
          sessionId: request.sessionId,
          sequence: 0,
          code: "UNAVAILABLE",
          fatal: true,
          message: "Cloud transcription connection closed unexpectedly",
        });
      }
    });

    return new CloudEngineSession(socket, request.sessionId, onEvent);
  }

  async dispose(): Promise<void> {}
}
