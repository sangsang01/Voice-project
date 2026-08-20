export interface SocketEventMap {
    open: Event;
    message: MessageEvent<string | ArrayBuffer>;
    close: CloseEvent;
    error: Event;
}
export interface SocketLike {
    readonly readyState: number;
    readonly bufferedAmount: number;
    binaryType: BinaryType;
    send(data: string | ArrayBuffer): void;
    close(code?: number, reason?: string): void;
    addEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void): void;
    removeEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void): void;
}
export type SocketFactory = (url: string, protocols: readonly string[]) => SocketLike;
export declare const defaultSocketFactory: SocketFactory;
