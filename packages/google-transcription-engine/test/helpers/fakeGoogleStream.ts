import { EventEmitter } from "node:events";
import type { GoogleDuplex, GoogleStreamingRequestChunk, SpeechClientFactory } from "../../src/googleClientFactory";
import type { GoogleProviderError, GoogleStreamingRecognizeResponse } from "../../src/providerTypes";

export class FakeGoogleDuplex extends EventEmitter implements GoogleDuplex {
  readonly writes: GoogleStreamingRequestChunk[] = [];
  ended = false;
  destroyed = false;
  writeReturnValue = true;

  write(chunk: GoogleStreamingRequestChunk): boolean {
    this.writes.push(chunk);
    return this.writeReturnValue;
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  override on(event: string, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    return this;
  }

  override removeAllListeners(): this {
    super.removeAllListeners();
    return this;
  }

  emitData(response: GoogleStreamingRecognizeResponse): void {
    this.emit("data", response);
  }

  emitError(error: GoogleProviderError): void {
    this.emit("error", error);
  }
}

export function createFakeSpeechClientFactory(): { factory: SpeechClientFactory; duplex: FakeGoogleDuplex } {
  const duplex = new FakeGoogleDuplex();
  const factory: SpeechClientFactory = { open: () => duplex };
  return { factory, duplex };
}
