import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type RawData, type WebSocket as WsWebSocket } from "ws";
import { isAllowedOrigin, type Limits } from "./config";
import { SessionRegistry } from "./websocket/sessionLimits";
import {
  attachTranscriptionHandler,
  type HandlerLogger,
  type HandlerSocket,
  type ProviderSessionFactory,
  type TranscriptionHandler,
} from "./websocket/transcriptionHandler";

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Adapts a `ws` socket to the transport-agnostic HandlerSocket the handler
 * tests against with a fake. removeAllListeners() only removes the specific
 * listeners this adapter registered -- calling ws.removeAllListeners()
 * would also strip ws's own internal listener that maintains
 * WebSocketServer#clients, hanging wss.close() forever.
 */
class WsHandlerSocket implements HandlerSocket {
  private readonly ownListeners: Array<{ event: string; listener: (...args: any[]) => void }> = [];

  constructor(private readonly ws: WsWebSocket) {}

  get readyState(): number {
    return this.ws.readyState;
  }

  send(data: string): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(data);
  }

  close(code?: number): void {
    try {
      this.ws.close(code);
    } catch {
      // socket already closing/closed
    }
  }

  on(event: "message", listener: (data: Buffer | string, isBinary: boolean) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: string, listener: (...args: any[]) => void): void {
    if (event === "message") {
      const wrapped = (data: RawData, isBinary: boolean) => listener(toBuffer(data), isBinary);
      this.ws.on("message", wrapped);
      this.ownListeners.push({ event: "message", listener: wrapped });
      return;
    }
    this.ws.on(event, listener);
    this.ownListeners.push({ event, listener });
  }

  removeAllListeners(): void {
    for (const { event, listener } of this.ownListeners) this.ws.off(event, listener);
    this.ownListeners.length = 0;
  }
}

export interface CreateServerOptions {
  createProviderSession: ProviderSessionFactory;
  limits: Limits;
  allowedOrigins: readonly string[];
  logger?: HandlerLogger;
}

export interface TranscriptionServer {
  httpServer: HttpServer;
  address(): AddressInfo | null;
  close(): Promise<void>;
}

/** Testable without credentials: the caller injects the provider session factory. */
export function createServer(options: CreateServerOptions): TranscriptionServer {
  const registry = new SessionRegistry(options.limits.maxConcurrentSessions);
  const httpServer = createHttpServer();
  const wss = new WebSocketServer({ noServer: true });
  const handlers = new Set<TranscriptionHandler>();

  httpServer.on("upgrade", (request, socket, head) => {
    if (!isAllowedOrigin(request.headers.origin, options.allowedOrigins)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws: WsWebSocket) => {
    const handler = attachTranscriptionHandler({
      socket: new WsHandlerSocket(ws),
      limits: options.limits,
      registry,
      createProviderSession: options.createProviderSession,
      ...(options.logger ? { logger: options.logger } : {}),
    });
    handlers.add(handler);
    ws.once("close", () => handlers.delete(handler));
  });

  return {
    httpServer,
    address: () => httpServer.address() as AddressInfo | null,
    async close(): Promise<void> {
      await Promise.all([...handlers].map((handler) => handler.finalize("server-shutdown")));
      handlers.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
