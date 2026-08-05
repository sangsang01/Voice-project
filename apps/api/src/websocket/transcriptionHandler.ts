import type { EngineEvent } from "@voice/transcription-contracts";
import type { Limits } from "../config";
import { createProtocolState, parseClientMessage, ProtocolError } from "./protocol";
import type { ClientMessage } from "./protocol";
import { SessionLimits, SessionRegistry } from "./sessionLimits";

export const SOCKET_OPEN = 1;

export interface HandlerSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  on(event: "message", listener: (data: Buffer | string, isBinary: boolean) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  removeAllListeners(): void;
}

export interface ProviderSession {
  write(frame: { sequence: number; samples: Int16Array }): boolean;
  stop(): Promise<void> | void;
  cancel(): void;
}

export type ProviderSessionFactory = (options: {
  sessionId: string;
  candidateLanguages: readonly string[];
  onEvent: (event: EngineEvent) => void;
}) => ProviderSession;

export type FinalizeReason =
  | "stop"
  | "cancel"
  | "disconnect"
  | "idle-timeout"
  | "hard-timeout"
  | "protocol-error"
  | "provider-error"
  | "capacity"
  | "server-shutdown";

export interface HandlerLogger {
  info(fields: Record<string, string | number | boolean>): void;
}

export interface TranscriptionHandlerOptions {
  socket: HandlerSocket;
  limits: Limits;
  registry: SessionRegistry;
  createProviderSession: ProviderSessionFactory;
  logger?: HandlerLogger;
}

export interface TranscriptionHandler {
  finalize(reason: FinalizeReason, closeCode?: number): Promise<void>;
}

const FRAME_DURATION_MS = 20;

function closeCodeFor(reason: FinalizeReason, explicitCode?: number): number {
  if (explicitCode) return explicitCode;
  if (reason === "provider-error" || reason === "server-shutdown") return 1011;
  if (reason === "capacity") return 1013;
  return 1000;
}

export function attachTranscriptionHandler(options: TranscriptionHandlerOptions): TranscriptionHandler {
  const { socket, limits, registry, createProviderSession } = options;
  const logger = options.logger ?? { info: () => {} };
  const protocolState = createProtocolState();

  let finalized = false;
  let sessionId = "unknown";
  let sessionLimits: SessionLimits | undefined;
  let providerSession: ProviderSession | undefined;
  let registryAcquired = false;
  let audioSequence = 0;
  let startedAtMs = 0;

  function safeSend(event: EngineEvent): void {
    if (finalized) return;
    if (socket.readyState !== SOCKET_OPEN) return;
    socket.send(JSON.stringify(event));
  }

  async function finalize(reason: FinalizeReason, explicitCloseCode?: number): Promise<void> {
    if (finalized) return;
    finalized = true;

    sessionLimits?.dispose();
    socket.removeAllListeners();

    if (providerSession) {
      if (reason === "stop") await providerSession.stop();
      else providerSession.cancel();
    }

    if (registryAcquired) {
      registry.release();
      registryAcquired = false;
    }

    const code = closeCodeFor(reason, explicitCloseCode);
    if (socket.readyState === SOCKET_OPEN) socket.close(code);

    logger.info({
      sessionId,
      reason,
      durationMs: startedAtMs ? Date.now() - startedAtMs : 0,
      framesForwarded: audioSequence,
    });
  }

  function handleMessage(message: ClientMessage): void {
    switch (message.kind) {
      case "session.start": {
        if (!registry.tryAcquire()) {
          void finalize("capacity");
          return;
        }
        registryAcquired = true;
        sessionId = message.request.sessionId;
        startedAtMs = Date.now();
        sessionLimits = new SessionLimits({
          limits,
          onIdleTimeout: () => void finalize("idle-timeout"),
          onHardTimeout: () => void finalize("hard-timeout"),
        });
        providerSession = createProviderSession({
          sessionId,
          candidateLanguages: message.request.candidateLanguages,
          onEvent: (event) => {
            safeSend(event);
            if (event.type === "error" && event.fatal) void finalize("provider-error");
          },
        });
        return;
      }
      case "audio.frame": {
        sessionLimits?.bufferAudio(FRAME_DURATION_MS);
        audioSequence += 1;
        const samples = new Int16Array(
          message.frame.buffer,
          message.frame.byteOffset,
          message.frame.byteLength / Int16Array.BYTES_PER_ELEMENT,
        );
        providerSession?.write({ sequence: audioSequence, samples });
        return;
      }
      case "session.stop":
        void finalize("stop");
        return;
      case "session.cancel":
        void finalize("cancel");
        return;
      case "session.ping":
        return;
    }
  }

  socket.on("message", (data, isBinary) => {
    if (finalized) return;
    let message: ClientMessage;
    try {
      message = parseClientMessage(protocolState, data, isBinary);
    } catch (error) {
      if (error instanceof ProtocolError) void finalize("protocol-error", error.closeCode);
      return;
    }
    sessionLimits?.recordActivity();
    handleMessage(message);
  });

  socket.on("close", () => void finalize("disconnect"));
  socket.on("error", () => void finalize("disconnect"));

  return { finalize };
}
