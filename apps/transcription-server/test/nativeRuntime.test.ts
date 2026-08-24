import type { NativeDecodeResult, NativeRuntimeHandle } from "@voice/native-whisper-addon";
import type { PcmFrame, SessionRequest } from "@voice/transcription-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createNativeStreamingRuntime } from "../src/nativeRuntime.js";
import { VAD_DEFAULTS } from "../src/vadGate.js";

const request: SessionRequest = {
  sessionId: "session-1",
  candidateLanguages: ["en-US", "vi-VN"],
  mode: "transcribe",
  audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 },
};

const DECODE_RESULT: NativeDecodeResult = {
  text: "hello",
  language: "en",
  languageProbability: 1,
  startMs: 0,
  endMs: 800,
};

const windowsFor = (ms: number) => Math.ceil(ms / VAD_DEFAULTS.windowMs);

function frame(sequence: number, fill = 1000): PcmFrame {
  return {
    sequence,
    startMs: sequence * 20,
    samples: Int16Array.from({ length: 320 }, () => fill),
  };
}

function probs(value: number, count: number): Float32Array {
  return Float32Array.from({ length: count }, () => value);
}

function fakeHandle(overrides: Partial<NativeRuntimeHandle> = {}): NativeRuntimeHandle {
  return {
    pushVad: vi.fn(() => new Float32Array(0)),
    decode: vi.fn(async () => DECODE_RESULT),
    warmup: vi.fn(async () => undefined),
    reset: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

function createRuntime(createHandle: () => NativeRuntimeHandle, extra: { decodeTimeoutMs?: number; useGpu?: boolean; modelPath?: string } = {}) {
  return createNativeStreamingRuntime({
    modelPath: extra.modelPath ?? "models/ggml-small.bin",
    vadModelPath: "models/ggml-silero-v6.2.0.bin",
    threads: 4,
    useGpu: extra.useGpu ?? false,
    decodeTimeoutMs: extra.decodeTimeoutMs,
    createHandle,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createNativeStreamingRuntime", () => {
  it("ready() creates one handle, warms it once, and sets loadCount to 1", async () => {
    const order: string[] = [];
    const handle = fakeHandle({
      warmup: vi.fn(async () => {
        order.push("warmup");
      }),
    });
    const createHandle = vi.fn(() => {
      order.push("create");
      return handle;
    });
    const runtime = createRuntime(createHandle);

    await runtime.ready();
    await runtime.ready();

    expect(createHandle).toHaveBeenCalledTimes(1);
    expect(handle.warmup).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["create", "warmup"]);
    expect(runtime.loadCount).toBe(1);
  });

  it("closes the native handle when warmup fails and retries ready()", async () => {
    const handles: NativeRuntimeHandle[] = [];
    let failWarmup = true;
    const createHandle = vi.fn(() => {
      const handle = fakeHandle({
        warmup: vi.fn(async () => {
          if (failWarmup) throw new Error("warmup failed");
        }),
      });
      handles.push(handle);
      return handle;
    });
    const runtime = createRuntime(createHandle);

    await expect(runtime.ready()).rejects.toThrow(/warmup failed/);
    expect(createHandle).toHaveBeenCalledTimes(1);
    expect(handles[0]!.close).toHaveBeenCalledTimes(1);
    expect(runtime.loadCount).toBe(0);

    failWarmup = false;
    await runtime.ready();
    expect(createHandle).toHaveBeenCalledTimes(2);
    expect(handles[1]!.warmup).toHaveBeenCalledTimes(1);
    expect(handles[1]!.close).not.toHaveBeenCalled();
    expect(runtime.loadCount).toBe(1);
  });

  it("closes a recycled handle when post-timeout warmup fails", async () => {
    vi.useFakeTimers();
    const handles: NativeRuntimeHandle[] = [];
    const createHandle = vi.fn(() => {
      const handle = fakeHandle({
        decode: vi.fn(() => new Promise<NativeDecodeResult>(() => undefined)),
        warmup: vi.fn(async () => {
          if (handles.length === 2) throw new Error("warmup failed");
        }),
      });
      handles.push(handle);
      return handle;
    });
    const runtime = createRuntime(createHandle);
    await runtime.ready();
    const session = await runtime.open(request);

    const hanging = session.decode("final", new Int16Array([1]), "");
    const failed = expect(hanging).rejects.toThrow(/warmup failed|TIMEOUT/i);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;

    expect(handles[0]!.close).toHaveBeenCalledTimes(1);
    expect(handles[1]!.close).toHaveBeenCalledTimes(1);
    expect(runtime.loadCount).toBe(1);

    await session.close();
    await runtime.ready();
    expect(createHandle).toHaveBeenCalledTimes(3);
    expect(handles[2]!.warmup).toHaveBeenCalledTimes(1);
    expect(handles[2]!.close).not.toHaveBeenCalled();
    expect(runtime.loadCount).toBe(2);
  });

  it("reuses the warm handle across sequential opens and throws when busy", async () => {
    const handle = fakeHandle();
    const createHandle = vi.fn(() => handle);
    const runtime = createRuntime(createHandle);
    await runtime.ready();

    const first = await runtime.open(request);
    await expect(runtime.open({ ...request, sessionId: "session-2" })).rejects.toThrow(/busy/i);
    expect(createHandle).toHaveBeenCalledTimes(1);

    await first.close();
    const second = await runtime.open({ ...request, sessionId: "session-2" });
    await second.close();

    expect(createHandle).toHaveBeenCalledTimes(1);
    expect(runtime.loadCount).toBe(1);
  });

  it("push converts PCM to int16, feeds Silero probabilities into the VAD gate, and maps flushes", async () => {
    const handle = fakeHandle({
      pushVad: vi.fn(() => new Float32Array(0)),
    });
    const runtime = createRuntime(() => handle);
    await runtime.ready();
    const session = await runtime.open(request);

    const speechFrame = frame(0, 1234);
    vi.mocked(handle.pushVad).mockReturnValueOnce(probs(0.9, windowsFor(VAD_DEFAULTS.minSpeechMs)));
    expect(session.push(speechFrame)).toEqual({
      speechStarted: true,
      speechEnded: false,
      maxDuration: false,
    });
    const pushed = vi.mocked(handle.pushVad).mock.calls[0]![0];
    expect(pushed).toBeInstanceOf(Int16Array);
    expect(Array.from(pushed)).toEqual(Array.from(speechFrame.samples));

    vi.mocked(handle.pushVad).mockReturnValueOnce(probs(0.1, windowsFor(VAD_DEFAULTS.minSilenceMs) + 1));
    expect(session.push(frame(1))).toEqual({
      speechStarted: false,
      speechEnded: true,
      maxDuration: false,
    });

    vi.mocked(handle.pushVad).mockReturnValueOnce(
      probs(0.9, windowsFor(VAD_DEFAULTS.maxSpeechMs) + windowsFor(VAD_DEFAULTS.minSpeechMs) + 1),
    );
    const max = session.push(frame(2));
    expect(max.maxDuration).toBe(true);
    expect(max.speechEnded).toBe(false);

    await session.close();
  });

  it("pins whisper language when the session has one candidate", async () => {
    const handle = fakeHandle();
    const runtime = createRuntime(() => handle);
    await runtime.ready();
    const session = await runtime.open({ ...request, candidateLanguages: ["en-US"] });
    await session.decode("provisional", new Int16Array([1]), "");
    expect(handle.decode).toHaveBeenCalledWith(expect.any(Int16Array), "", "en");
    await session.close();
  });

  it("re-decodes as Vietnamese when auto-detect returns Chinese and Chinese is not selected", async () => {
    const handle = fakeHandle({
      decode: vi.fn(async (_audio, _prompt, lang) => {
        if (lang === "vi") {
          return { ...DECODE_RESULT, text: "Xin chào", language: "vi" };
        }
        return { ...DECODE_RESULT, text: "新郎", language: "zh" };
      }),
    });
    const runtime = createRuntime(() => handle);
    await runtime.ready();
    const session = await runtime.open(request);
    const result = await session.decode("provisional", new Int16Array([1]), "");
    expect(handle.decode).toHaveBeenNthCalledWith(1, expect.any(Int16Array), "", undefined);
    expect(handle.decode).toHaveBeenNthCalledWith(2, expect.any(Int16Array), "", "vi");
    expect(result).toMatchObject({ text: "Xin chào", language: "vi" });
    await session.close();
  });

  it("does not pin later decodes to the first detected language", async () => {
    const handle = fakeHandle({
      decode: vi.fn(async () => ({ ...DECODE_RESULT, text: "Xin chào", language: "vi" })),
    });
    const runtime = createRuntime(() => handle);
    await runtime.ready();
    const session = await runtime.open(request);
    await session.decode("provisional", new Int16Array([1]), "");
    await session.decode("provisional", new Int16Array([2]), "");
    expect(handle.decode).toHaveBeenNthCalledWith(1, expect.any(Int16Array), "", undefined);
    expect(handle.decode).toHaveBeenNthCalledWith(2, expect.any(Int16Array), "", undefined);
    await session.close();
  });

  it("keeps the auto-detect result when the Vietnamese retry fails", async () => {
    const handle = fakeHandle({
      decode: vi.fn(async (_audio, _prompt, lang) => {
        if (lang === "vi") throw new Error("whisper_full failed");
        return { ...DECODE_RESULT, text: "新郎", language: "zh" };
      }),
    });
    const runtime = createRuntime(() => handle);
    await runtime.ready();
    const session = await runtime.open(request);
    const result = await session.decode("provisional", new Int16Array([1]), "");
    expect(result).toMatchObject({ text: "新郎", language: "zh" });
    await session.close();
  });

  it("decode forwards to the handle and recycles on timeout with TIMEOUT", async () => {
    vi.useFakeTimers();
    const handles: NativeRuntimeHandle[] = [];
    const createHandle = vi.fn(() => {
      const handle = fakeHandle({
        decode: vi.fn(() => new Promise<NativeDecodeResult>(() => undefined)),
      });
      handles.push(handle);
      return handle;
    });
    const runtime = createRuntime(createHandle);
    await runtime.ready();
    const session = await runtime.open(request);

    const samples = new Int16Array([1, 2, 3]);
    const hanging = session.decode("final", samples, "prompt");
    const timedOut = expect(hanging).rejects.toThrow(/TIMEOUT/i);
    await Promise.resolve();
    expect(handles[0]!.decode).toHaveBeenCalledWith(samples, "", undefined);

    await vi.advanceTimersByTimeAsync(30_000);
    await timedOut;

    expect(handles[0]!.close).toHaveBeenCalledTimes(1);
    expect(createHandle).toHaveBeenCalledTimes(2);
    expect(handles[1]!.warmup).toHaveBeenCalledTimes(1);
    expect(runtime.loadCount).toBe(2);

    await expect(runtime.open({ ...request, sessionId: "session-2" })).rejects.toThrow(/busy/i);
    await session.close();
    expect(handles[1]!.reset).toHaveBeenCalledTimes(1);
    expect(handles[1]!.close).not.toHaveBeenCalled();
  });

  it("recycles the native handle after whisper_full fails so a later decode can run", async () => {
    const handles: NativeRuntimeHandle[] = [];
    const createHandle = vi.fn(() => {
      const handle = fakeHandle({
        decode: vi.fn(async () => {
          if (handles.length === 1) throw new Error("whisper_full failed");
          return DECODE_RESULT;
        }),
      });
      handles.push(handle);
      return handle;
    });
    const runtime = createRuntime(createHandle);
    await runtime.ready();
    const session = await runtime.open(request);

    await expect(session.decode("final", new Int16Array([1]), "")).rejects.toThrow(/whisper_full failed/);
    expect(handles[0]!.close).toHaveBeenCalledTimes(1);
    expect(createHandle).toHaveBeenCalledTimes(2);
    expect(handles[1]!.warmup).toHaveBeenCalledTimes(1);

    await expect(session.decode("final", new Int16Array([2]), "")).resolves.toEqual(DECODE_RESULT);
    await session.close();
  });

  it("session close resets a healthy handle instead of unloading it", async () => {
    const handle = fakeHandle();
    const runtime = createRuntime(() => handle);
    await runtime.ready();
    const session = await runtime.open(request);
    await session.close();

    expect(handle.reset).toHaveBeenCalledTimes(1);
    expect(handle.close).not.toHaveBeenCalled();
    expect(runtime.loadCount).toBe(1);
  });

  it("process shutdown closes the handle once", async () => {
    const handle = fakeHandle();
    const runtime = createRuntime(() => handle);
    await runtime.ready();
    const session = await runtime.open(request);
    await session.close();

    await runtime.close();
    await runtime.close();

    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("uses the model basename and rejects .en paths before createHandle", () => {
    const createHandle = vi.fn(() => fakeHandle());
    const runtime = createRuntime(createHandle, { modelPath: "C:\\\\weights\\\\ggml-small.bin" });
    expect(runtime.modelName).toBe("ggml-small.bin");
    expect(runtime.backend).toBe("cpu");
    expect(createHandle).not.toHaveBeenCalled();

    expect(() =>
      createNativeStreamingRuntime({
        modelPath: "models/ggml-tiny.en.bin",
        vadModelPath: "models/ggml-silero-v6.2.0.bin",
        threads: 4,
        useGpu: false,
        createHandle,
      }),
    ).toThrow("VOICE_MODEL_PATH must reference a multilingual model");
    expect(createHandle).not.toHaveBeenCalled();
  });

  it("reports a GPU backend only when useGpu is set", () => {
    const runtime = createRuntime(() => fakeHandle(), { useGpu: true });
    expect(runtime.backend).toBe("cuda");
  });
});
