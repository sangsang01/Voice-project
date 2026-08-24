import type { PcmFrame, SessionRequest } from "@voice/transcription-contracts";

import type { DecodeResult, StreamingRuntime, StreamingRuntimeSession, VadUpdate } from "./runtime.js";

const SILENT_VAD: VadUpdate = { speechStarted: false, speechEnded: false, maxDuration: false };

class FakeRuntimeSession implements StreamingRuntimeSession {
  public push(_frame: PcmFrame): VadUpdate {
    return SILENT_VAD;
  }

  public decode(): Promise<DecodeResult> {
    return Promise.resolve({
      text: "",
      language: "und",
      languageProbability: 0,
      startMs: 0,
      endMs: 0,
    });
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

export class FakeRuntime implements StreamingRuntime {
  public loadCount = 0;
  public openCount = 0;
  public readonly modelName = "tiny";
  public readonly backend = "cpu" as const;
  public readyGate: Promise<void> | undefined;
  private loaded = false;

  public async ready(): Promise<void> {
    if (this.readyGate) await this.readyGate;
    if (this.loaded) return;
    this.loaded = true;
    this.loadCount += 1;
  }

  public open(_request: SessionRequest): Promise<StreamingRuntimeSession> {
    this.openCount += 1;
    return Promise.resolve(new FakeRuntimeSession());
  }
}
