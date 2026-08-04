import type { EngineEvent } from "./events";
import type { PcmFrame, SessionRequest } from "./types";

export interface EngineCapabilities {
  supported: boolean;
  reason?: string;
}

export type EngineEventListener = (event: EngineEvent) => void;

export interface EngineSession {
  push(frame: PcmFrame): void;
  stop(): Promise<void>;
  cancel(): void;
}

export interface TranscriptionEngine {
  inspect(): Promise<EngineCapabilities> | EngineCapabilities;
  prepare(): Promise<void>;
  open(request: SessionRequest, onEvent: EngineEventListener): Promise<EngineSession>;
  dispose(): Promise<void>;
}
