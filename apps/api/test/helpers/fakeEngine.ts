import { EventEmitter } from "node:events";
import type { EngineEvent } from "@voice/transcription-contracts";
import type { HandlerSocket, ProviderSession, ProviderSessionFactory } from "../../src/websocket/transcriptionHandler";

export class FakeProviderSession implements ProviderSession {
  readonly writes: { sequence: number; samples: Int16Array }[] = [];
  stopCalls = 0;
  cancelCalls = 0;
  writeReturnValue = true;

  write(frame: { sequence: number; samples: Int16Array }): boolean {
    this.writes.push(frame);
    return this.writeReturnValue;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  cancel(): void {
    this.cancelCalls += 1;
  }
}

export function createFakeProviderSessionFactory(): {
  factory: ProviderSessionFactory;
  sessions: FakeProviderSession[];
  emit: (event: EngineEvent) => void;
} {
  const sessions: FakeProviderSession[] = [];
  let currentOnEvent: ((event: EngineEvent) => void) | undefined;

  const factory: ProviderSessionFactory = ({ onEvent }) => {
    currentOnEvent = onEvent;
    const session = new FakeProviderSession();
    sessions.push(session);
    return session;
  };

  return {
    factory,
    sessions,
    emit: (event) => currentOnEvent?.(event),
  };
}

export class FakeSocket extends EventEmitter implements HandlerSocket {
  readyState = 1;
  readonly sent: string[] = [];
  closed = false;
  closeCode: number | undefined;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
    this.readyState = 3;
  }

  override on(event: string, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    return this;
  }

  override removeAllListeners(): this {
    super.removeAllListeners();
    return this;
  }

  receive(data: Buffer | string, isBinary: boolean): void {
    this.emit("message", data, isBinary);
  }

  disconnect(): void {
    this.readyState = 3;
    this.emit("close");
  }
}
