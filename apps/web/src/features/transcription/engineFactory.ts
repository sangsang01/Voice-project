import { CloudEngineClient } from "@voice/google-transcription-engine/browser";
import { LocalWhisperEngine } from "@voice/local-whisper-engine";
import type { TranscriptionEngine } from "@voice/transcription-contracts";

export interface CreateTranscriptionEngineOptions {
  kind: "local" | "cloud";
  cloudConsent: boolean;
  websocketUrl: string;
  onProgress?: (progress: number) => void;
}

/**
 * The only place apps/web chooses between engines. Never imports anything
 * server-side: CloudEngineClient comes from the package's browser-only
 * entrypoint, which never references @google-cloud/speech.
 */
export function createTranscriptionEngine(options: CreateTranscriptionEngineOptions): TranscriptionEngine {
  if (options.kind === "local") return new LocalWhisperEngine({ onProgress: options.onProgress });
  return new CloudEngineClient({
    cloudConsent: options.cloudConsent,
    websocketUrl: options.websocketUrl,
  });
}
