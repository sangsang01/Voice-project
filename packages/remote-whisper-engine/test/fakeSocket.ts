import type { SocketEventMap, SocketLike } from "../src/socket.js";

type Handler<K extends keyof SocketEventMap> = (event: SocketEventMap[K]) => void;

function closeEvent(code: number, reason: string): CloseEvent {
  return { type: "close", code, reason } as CloseEvent;
}

function messageEvent(data: string | ArrayBuffer): MessageEvent<string | ArrayBuffer> {
  return { type: "message", data } as MessageEvent<string | ArrayBuffer>;
}

function openEvent(): Event {
  return { type: "open" } as Event;
}

export class FakeSocket implements SocketLike {
  public readyState = 0;
  public bufferedAmount = 0;
  public binaryType: BinaryType = "arraybuffer";
  public readonly sent: Array<string | ArrayBuffer> = [];
  public protocols: readonly string[] = [];
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  public constructor(public readonly url: string, protocols: readonly string[] = []) {
    this.protocols = protocols;
  }

  public send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  public close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.emit("close", closeEvent(code, reason));
  }

  public addEventListener<K extends keyof SocketEventMap>(type: K, listener: Handler<K>): void {
    const set = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    set.add(listener as (event: Event) => void);
    this.listeners.set(type, set);
  }

  public removeEventListener<K extends keyof SocketEventMap>(type: K, listener: Handler<K>): void {
    this.listeners.get(type)?.delete(listener as (event: Event) => void);
  }

  public open(): void {
    this.readyState = 1;
    this.emit("open", openEvent());
  }

  public emitJson(value: unknown): void {
    this.emit("message", messageEvent(JSON.stringify(value)));
  }

  public emitText(data: string): void {
    this.emit("message", messageEvent(data));
  }

  public sentJson(): unknown[] {
    return this.sent.filter((value): value is string => typeof value === "string").map((value) => JSON.parse(value));
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
