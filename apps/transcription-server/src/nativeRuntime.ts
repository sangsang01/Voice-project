import type { PcmFrame } from "@voice/transcription-contracts";
import type { NativeRuntimeHandle } from "@voice/native-whisper-addon";

import type { DecodeResult, StreamingRuntimeSession, VadUpdate } from "./runtime.js";
import { createVadGate, VAD_DEFAULTS } from "./vadGate.js";

const SAMPLE_RATE = 16_000;
const MAX_BUFFER_MS = VAD_DEFAULTS.maxSpeechMs + VAD_DEFAULTS.speechPadMs * 2;

export interface NativeRuntimeSessionOptions {
  handle: NativeRuntimeHandle;
  decodeTimeoutMs: number;
  /** Invoked exactly once when the lease is released. */
  release(outcome: "healthy" | "unhealthy"): Promise<void>;
}

/**
 * Adapts one leased native handle into the scheduler-facing session seam:
 * pushVad → VadGate → VadUpdate, with timed decode serialization owned by the
 * caller/pool mutex wrapping this session.
 */
export function createNativeRuntimeSession(
  options: NativeRuntimeSessionOptions,
): StreamingRuntimeSession {
  const gate = createVadGate();
  let windowIndex = 0;
  let speaking = false;
  let closed = false;
  let unhealthy = false;
  let pcm = new Int16Array(0);
  let pcmStartSample = 0;
  let decodeChain: Promise<void> = Promise.resolve();

  const markUnhealthy = () => {
    unhealthy = true;
  };

  const appendPcm = (samples: Int16Array) => {
    const next = new Int16Array(pcm.length + samples.length);
    next.set(pcm, 0);
    next.set(samples, pcm.length);
    pcm = next;

    const maxSamples = Math.floor((MAX_BUFFER_MS * SAMPLE_RATE) / 1000);
    if (pcm.length > maxSamples) {
      const drop = pcm.length - maxSamples;
      pcm = pcm.subarray(drop);
      pcmStartSample += drop;
    }
  };

  const trimFromMs = (retainFromMs: number) => {
    const retainSample = Math.floor((retainFromMs * SAMPLE_RATE) / 1000);
    const localIndex = Math.max(0, retainSample - pcmStartSample);
    if (localIndex <= 0) return;
    if (localIndex >= pcm.length) {
      pcmStartSample += pcm.length;
      pcm = new Int16Array(0);
      return;
    }
    pcm = pcm.subarray(localIndex);
    pcmStartSample += localIndex;
  };

  const raceDecode = async (audio: Int16Array, prompt: string): Promise<DecodeResult> => {
    const decodePromise = options.handle.decode(audio, prompt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        markUnhealthy();
        reject(new Error("native decode timeout"));
      }, options.decodeTimeoutMs);
    });

    try {
      return await Promise.race([decodePromise, timeoutPromise]);
    } catch (error) {
      // Abandon in-flight native work after timeout/close; swallow late rejections.
      void decodePromise.then(
        () => undefined,
        () => undefined,
      );
      if (!unhealthy && error instanceof Error && /fail|closed|error/i.test(error.message)) {
        markUnhealthy();
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return {
    push(frame: PcmFrame): VadUpdate {
      if (closed) return { speechStarted: false, speechEnded: false };

      appendPcm(frame.samples);
      const probs = options.handle.pushVad(frame.samples);
      let speechStarted = false;
      let speechEnded = false;

      for (let index = 0; index < probs.length; index += 1) {
        const windowStartMs = (windowIndex * VAD_DEFAULTS.windowMs);
        windowIndex += 1;
        const decision = gate.push(probs[index]!, windowStartMs);

        if (decision.type === "idle") {
          const retainFromMs =
            decision.retainFromMs ??
            windowStartMs + VAD_DEFAULTS.windowMs - VAD_DEFAULTS.speechPadMs;
          trimFromMs(retainFromMs);
          continue;
        }

        if (decision.type === "speaking") {
          if (!speaking) {
            speaking = true;
            speechStarted = true;
          }
          continue;
        }

        // flush
        speechEnded = true;
        speaking = false;
        trimFromMs(decision.endMs);
      }

      return { speechStarted, speechEnded };
    },

    decode(kind, audio, prompt) {
      void kind;
      if (closed) {
        return Promise.reject(new Error("native runtime session is closed"));
      }

      const run = decodeChain.then(() => raceDecode(audio, prompt));
      decodeChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },

    async close() {
      if (closed) return;
      closed = true;
      gate.reset();
      pcm = new Int16Array(0);
      await options.release(unhealthy ? "unhealthy" : "healthy");
    },
  };
}
