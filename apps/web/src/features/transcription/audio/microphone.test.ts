import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pcmWorkletSource } from "./pcm-worklet";
import {
  MicrophoneCaptureError,
  startMicrophoneCapture,
  type MicrophoneDependencies,
} from "./microphone";

function createDependencies(overrides: Partial<MicrophoneDependencies> = {}) {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const node = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    port: { onmessage: null as ((event: MessageEvent) => void) | null },
  };
  const context = {
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    createMediaStreamSource: vi.fn().mockReturnValue(source),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    dependencies: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => tracks }),
      createAudioContext: vi.fn().mockReturnValue(context),
      createWorkletNode: vi.fn().mockReturnValue(node),
      createWorkletUrl: vi.fn().mockReturnValue("http://localhost:5173/pcm-worklet.js"),
      revokeWorkletUrl: vi.fn(),
      isAudioWorkletSupported: vi.fn().mockReturnValue(true),
      ...overrides,
    },
    tracks,
    context,
    node,
    source,
  };
}

describe("startMicrophoneCapture", () => {
  it("requests a mono capture track with echo cancellation disabled", async () => {
    const { dependencies } = createDependencies();

    const capture = await startMicrophoneCapture({ onFrame: vi.fn(), dependencies });
    await capture.stop();

    expect(dependencies.getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
  });

  it("does not connect the capture worklet to speakers", async () => {
    const { dependencies, node, source, context } = createDependencies();
    Object.assign(context, { destination: { connect: vi.fn() } });

    const capture = await startMicrophoneCapture({ onFrame: vi.fn(), dependencies });
    await capture.stop();

    expect(source.connect).toHaveBeenCalledWith(node);
    expect(node.connect).not.toHaveBeenCalled();
  });

  it("constructs and resumes the context before requesting microphone permission", async () => {
    const calls: string[] = [];
    const { dependencies, context } = createDependencies({
      createAudioContext: vi.fn(() => {
        calls.push("create");
        return context;
      }),
      getUserMedia: vi.fn(async () => {
        calls.push("getUserMedia");
        return { getTracks: () => [] };
      }),
    });
    context.resume.mockImplementation(async () => {
      calls.push("resume");
    });

    const capture = await startMicrophoneCapture({ onFrame: vi.fn(), dependencies });
    await capture.stop();

    expect(calls).toEqual(["create", "resume", "getUserMedia"]);
    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it("maps microphone permission denial to the shared UNAVAILABLE error", async () => {
    const { dependencies } = createDependencies({
      getUserMedia: vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")),
    });

    await expect(startMicrophoneCapture({ onFrame: vi.fn(), dependencies })).rejects.toMatchObject(
      { code: "UNAVAILABLE" } satisfies Pick<MicrophoneCaptureError, "code">,
    );
  });

  it("stops all media tracks and closes the audio context exactly once", async () => {
    const { dependencies, tracks, context, node, source } = createDependencies();
    const capture = await startMicrophoneCapture({ onFrame: vi.fn(), dependencies });

    await Promise.all([capture.stop(), capture.stop()]);

    expect(tracks[0]?.stop).toHaveBeenCalledTimes(1);
    expect(tracks[1]?.stop).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(node.disconnect).toHaveBeenCalledTimes(1);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
  });

  it("maps missing worklet support to the shared UNSUPPORTED error", async () => {
    const { dependencies } = createDependencies({
      isAudioWorkletSupported: vi.fn().mockReturnValue(false),
    });

    await expect(startMicrophoneCapture({ onFrame: vi.fn(), dependencies })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(dependencies.getUserMedia).not.toHaveBeenCalled();
  });

  it("keeps the served worklet identical to the capture source", () => {
    const workletPath = resolve(process.cwd(), "public/pcm-worklet.js");
    const served = readFileSync(workletPath, "utf8").replace(/\r\n/g, "\n").trim();
    expect(served).toBe(pcmWorkletSource.replace(/\r\n/g, "\n").trim());
  });

  it("closes a resumed context without masking a startup failure", async () => {
    const { dependencies, context } = createDependencies();
    context.resume.mockRejectedValue(new Error("resume failed"));
    context.close.mockRejectedValue(new Error("close failed"));

    await expect(startMicrophoneCapture({ onFrame: vi.fn(), dependencies })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});
