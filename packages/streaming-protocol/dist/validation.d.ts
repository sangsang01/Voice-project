import type { ClientControl, ServerMessage } from "./messages.js";
export declare function parseJsonMessage(text: string): unknown;
export declare function validateClientControl(value: unknown): ClientControl;
export declare function validateServerMessage(value: unknown): ServerMessage;
