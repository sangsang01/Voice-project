/**
 * Production entrypoint: load the native whisper addon, warm a fixed decoder
 * pool, and serve authenticated WebSocket transcription sessions.
 */
import { type IncomingMessage, type ServerResponse } from "node:http";
export interface ServerEnv {
    modelPath: string;
    vadModelPath: string;
    port: number;
    allowedOrigins: string[];
    maxSessions: number;
    bindHost: string;
    requireAuth: boolean;
}
export declare function loadServerEnv(env?: NodeJS.ProcessEnv): ServerEnv;
export declare function main(env?: NodeJS.ProcessEnv): Promise<void>;
/** HTTP readiness: 200 only after every warm pool handle is available. */
export declare function handleHttpRequest(request: IncomingMessage, response: ServerResponse, isReady: () => boolean): void;
export declare function assertMultilingualModel(modelPath: string): void;
