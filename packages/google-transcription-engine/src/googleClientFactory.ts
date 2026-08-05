import { v1 } from "@google-cloud/speech";
import type { GoogleProviderError, GoogleStreamingRecognizeResponse } from "./providerTypes";

export interface GoogleStreamingRecognitionConfig {
  config: {
    encoding: "LINEAR16";
    sampleRateHertz: 16000;
    languageCode: string;
    alternativeLanguageCodes: string[];
  };
  interimResults: true;
}

export type GoogleStreamingRequestChunk =
  | { streamingConfig: GoogleStreamingRecognitionConfig }
  | { audioContent: Buffer };

export interface GoogleDuplex {
  write(chunk: GoogleStreamingRequestChunk): boolean;
  end(): void;
  destroy(error?: Error): void;
  on(event: "data", listener: (response: GoogleStreamingRecognizeResponse) => void): GoogleDuplex;
  on(event: "error", listener: (error: GoogleProviderError) => void): GoogleDuplex;
  on(event: "end", listener: () => void): GoogleDuplex;
  removeAllListeners(): GoogleDuplex;
}

export interface SpeechClientFactory {
  open(): GoogleDuplex;
}

/** The only function in this package that touches Application Default Credentials or the Google SDK. */
export function createProductionSpeechClientFactory(): SpeechClientFactory {
  const client = new v1.SpeechClient();
  return { open: () => client.streamingRecognize() as unknown as GoogleDuplex };
}
