import type { Server } from "node:http";
import type { MetricsSink } from "./metrics.js";
import type { StreamingRuntime } from "./runtime.js";
export interface AuthenticatedPrincipal {
    accountId: string;
}
export interface TranscriptionGatewayOptions {
    server: Server;
    runtime: StreamingRuntime;
    capacity: number;
    allowedOrigins: readonly string[];
    authenticate(token: string | undefined): AuthenticatedPrincipal | Promise<AuthenticatedPrincipal>;
    metrics?: MetricsSink;
}
export declare function createTranscriptionGateway(options: TranscriptionGatewayOptions): () => void;
