import type { SessionRequest } from "@voice/transcription-contracts";
import { describe, expect, it } from "vitest";

import { FakeRuntime } from "../src/fakeRuntime.js";

const request: SessionRequest = {
  sessionId: "session-1",
  candidateLanguages: ["en-US", "vi-VN"],
  mode: "transcribe",
  audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
};

describe("warm runtime", () => {
  it("loads weights once across two sessions", async () => {
    const runtime = new FakeRuntime();
    await runtime.ready();
    await (await runtime.open(request)).close();
    await (await runtime.open({ ...request, sessionId: "session-2" })).close();
    expect(runtime.loadCount).toBe(1);
  });
});
