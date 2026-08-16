import type { NativeAddon, NativeRuntimeHandle } from "@voice/native-whisper-addon";
import type { PcmFrame, SessionRequest } from "@voice/transcription-contracts";
import { posix } from "node:path";

import type { DecodeResult, StreamingRuntime, StreamingRuntimeSession, VadUpdate } from "./runtime.js";
import { createVadGate, VAD_DEFAULTS } from "./vadGate.js";

const DEFAULT_DECODE_TIMEOUT_MS = 30_000;
const SILENT_VAD: VadUpdate = { speechStarted: false, speechEnded: false, maxDuration: false };

export interface NativeStreamingRuntimeOptions {
  modelPath: string;
  vadModelPath: string;
  threads: number;
  useGpu: boolean;
  decodeTimeoutMs?: number;
  loadAddon?: () => NativeAddon;
  createHandle?: () => NativeRuntimeHandle;
}

export interface NativeStreamingRuntime extends StreamingRuntime {
  close(): Promise<void>;
}

export function createNativeStreamingRuntime(options: NativeStreamingRuntimeOptions): NativeStreamingRuntime {
  if (options.modelPath.includes(".en")) {
    throw new Error("VOICE_MODEL_PATH must reference a multilingual model");
  }

  const decodeTimeoutMs = options.decodeTimeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS;
  const modelName = posix.basename(options.modelPath.replace(/\\/g, "/"));
  const backend = options.useGpu ? "cuda" : "cpu";

  let addon: NativeAddon | undefined;
  let handle: NativeRuntimeHandle | undefined;
  let loadCount = 0;
  let activeSession: StreamingRuntimeSession | undefined;
  let closed = false;
  let readyPromise: Promise<void> | undefined;

  function makeHandle(): NativeRuntimeHandle {
    if (options.createHandle) return options.createHandle();
    if (!options.loadAddon) {
      throw new Error("native whisper loadAddon is required");
    }
    addon ??= options.loadAddon();
    return addon.createRuntime({
      modelPath: options.modelPath,
      vadModelPath: options.vadModelPath,
      threads: options.threads,
      useGpu: options.useGpu,
    });
  }

  async function ensureHandle(): Promise<void> {
    if (closed) throw new Error("native runtime is closed");
    if (handle) return;
    handle = makeHandle();
    await handle.warmup();
    loadCount += 1;
  }

  async function ready(): Promise<void> {
    readyPromise ??= ensureHandle();
    try {
      await readyPromise;
    } catch (error) {
      readyPromise = undefined;
      handle = undefined;
      throw error;
    }
  }

  async function recycle(): Promise<void> {
    handle?.close();
    handle = undefined;
    readyPromise = ensureHandle();
    await readyPromise;
  }

  async function open(_request: SessionRequest): Promise<StreamingRuntimeSession> {
    await ready();
    if (activeSession) throw new Error("native runtime is busy");

    const gate = createVadGate();
    let windowIndex = 0;
    let reportedSpeaking = false;

    const session: StreamingRuntimeSession = {
      push(frame: PcmFrame): VadUpdate {
        if (closed || activeSession !== session || !handle) return SILENT_VAD;
        const samples = new Int16Array(frame.samples);
        const probabilities = handle.pushVad(samples);
        const update: VadUpdate = { speechStarted: false, speechEnded: false, maxDuration: false };

        for (let index = 0; index < probabilities.length; index += 1) {
          const windowStartMs = windowIndex * VAD_DEFAULTS.windowMs;
          windowIndex += 1;
          const decision = gate.push(probabilities[index]!, windowStartMs);
          if (decision.type === "speaking") {
            if (!reportedSpeaking) {
              update.speechStarted = true;
              reportedSpeaking = true;
            }
            continue;
          }
          if (decision.type !== "flush") continue;
          if (!reportedSpeaking) update.speechStarted = true;
          reportedSpeaking = false;
          if (decision.reason === "silence") update.speechEnded = true;
          if (decision.reason === "max-duration") update.maxDuration = true;
        }

        return update;
      },

      async decode(_kind: "provisional" | "final", audio: Int16Array, prompt: string): Promise<DecodeResult> {
        if (!handle) throw new Error("native runtime handle is missing");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const decodePromise = handle.decode(audio, prompt);
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("TIMEOUT")), decodeTimeoutMs);
        });
        // Both legs can lose the race; attach swallows so the loser is not unhandled.
        void decodePromise.catch(() => undefined);
        void timeoutPromise.catch(() => undefined);
        try {
          return await Promise.race([decodePromise, timeoutPromise]);
        } catch (error) {
          if (error instanceof Error && /timeout/i.test(error.message)) {
            await recycle();
            throw error;
          }
          throw error;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      },

      close(): Promise<void> {
        if (activeSession !== session) return Promise.resolve();
        activeSession = undefined;
        gate.reset();
        if (!closed) handle?.reset();
        return Promise.resolve();
      },
    };
    activeSession = session;
    return session;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    activeSession = undefined;
    handle?.close();
    handle = undefined;
  }

  return {
    get modelName() {
      return modelName;
    },
    get backend() {
      return backend;
    },
    get loadCount() {
      return loadCount;
    },
    ready,
    open,
    close,
  };
}
