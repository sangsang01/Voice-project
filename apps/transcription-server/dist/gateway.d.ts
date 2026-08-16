import type { StreamingRuntime } from "./runtime.js";
export interface GatewayOptions {
    host: string;
    port: number;
    runtime: StreamingRuntime;
    capacity?: number;
    allowedOrigins: readonly string[];
}
export interface TranscriptionGateway {
    readonly host: string;
    readonly port: number;
    close(): Promise<void>;
}
export declare function createTranscriptionGateway(options: GatewayOptions): Promise<TranscriptionGateway>;
