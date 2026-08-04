import type { EngineEvent } from "@voice/transcription-contracts";
import type { GoogleDuplex, GoogleStreamingRecognitionConfig, SpeechClientFactory } from "./googleClientFactory";
import { toGoogleLanguageConfig } from "./languageConfig";
import { normalizeGoogleError, normalizeGoogleResult } from "./normalizeResult";
import type { GoogleProviderError, GoogleStreamingRecognizeResponse } from "./providerTypes";

export interface GoogleStreamOptions {
  sessionId: string;
  candidateLanguages: readonly string[];
  factory: SpeechClientFactory;
  onEvent: (event: EngineEvent) => void;
}

export interface GoogleAudioFrame {
  sequence: number;
  samples: Int16Array;
}

/**
 * Google's V1 streaming API reports one evolving result per utterance and
 * never assigns it a stable id. This wrapper tracks ordinal/revision itself:
 * a new ordinal starts whenever the previous result went final (or on the
 * very first result), otherwise the same ordinal's revision is bumped.
 */
export class GoogleStream {
  private readonly duplex: GoogleDuplex;
  private readonly sessionId: string;
  private readonly selectedLanguages: readonly string[];
  private readonly onEvent: (event: EngineEvent) => void;

  private sequence = 0;
  private ordinal = 0;
  private revision = 0;
  private startMs = 0;
  private lastEndMs = 0;
  private awaitingNewOrdinal = true;
  private closed = false;

  constructor(options: GoogleStreamOptions) {
    this.sessionId = options.sessionId;
    this.selectedLanguages = options.candidateLanguages;
    this.onEvent = options.onEvent;

    const languageConfig = toGoogleLanguageConfig(options.candidateLanguages);
    this.duplex = options.factory.open();
    this.duplex.on("data", (response) => this.handleResponse(response));
    this.duplex.on("error", (error) => this.handleError(error));
    this.duplex.on("end", () => this.close(false));

    const streamingConfig: GoogleStreamingRecognitionConfig = {
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        languageCode: languageConfig.languageCode,
        alternativeLanguageCodes: languageConfig.alternativeLanguageCodes,
      },
      interimResults: true,
    };
    this.duplex.write({ streamingConfig });
  }

  /** Converts only this frame's own bytes to a Buffer; returns false when the underlying duplex applies backpressure. */
  write(frame: GoogleAudioFrame): boolean {
    if (this.closed) return false;
    const buffer = Buffer.from(frame.samples.buffer, frame.samples.byteOffset, frame.samples.byteLength);
    return this.duplex.write({ audioContent: buffer });
  }

  stop(): void {
    this.close(false);
  }

  cancel(): void {
    this.close(true);
  }

  private close(destroy: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.duplex.removeAllListeners();
    if (destroy) this.duplex.destroy();
    else this.duplex.end();
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private handleResponse(response: GoogleStreamingRecognizeResponse): void {
    for (const result of response.results ?? []) {
      if (this.awaitingNewOrdinal) {
        this.ordinal += 1;
        this.revision = 1;
        this.startMs = this.lastEndMs;
      } else {
        this.revision += 1;
      }

      const event = normalizeGoogleResult(result, {
        sessionId: this.sessionId,
        sequence: this.nextSequence(),
        ordinal: this.ordinal,
        revision: this.revision,
        startMs: this.startMs,
        selectedLanguages: this.selectedLanguages,
      });

      if (event) {
        this.onEvent(event);
        if (event.type === "segment.upsert") this.lastEndMs = event.segment.endMs;
      }

      this.awaitingNewOrdinal = result.isFinal === true;
    }
  }

  private handleError(error: GoogleProviderError): void {
    this.onEvent(normalizeGoogleError(error, { sessionId: this.sessionId, sequence: this.nextSequence() }));
  }
}
