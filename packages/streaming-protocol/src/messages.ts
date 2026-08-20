import type { EngineEvent, SessionRequest } from "@voice/transcription-contracts";

export type ClientControl =
  | { type: "session.start"; protocol: 1; request: SessionRequest }
  | { type: "session.stop"; sessionId: string }
  | { type: "session.cancel"; sessionId: string };

export type ServerMessage =
  | { type: "session.accepted"; sessionId: string; model: string }
  | { type: "audio.ack"; sessionId: string; throughSequence: number }
  | { type: "engine.event"; event: EngineEvent };
