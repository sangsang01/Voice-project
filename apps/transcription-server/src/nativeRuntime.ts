import type { PcmFrame } from "@voice/transcription-contracts";
import type { NativeRuntimeHandle } from "@voice/native-whisper-addon";

import type { DecodeResult, StreamingRuntimeSession, VadUpdate } from "./runtime.js";
import { createVadGate, VAD_DEFAULTS } from "./vadGate.js";

export interface NativeRuntimeSessionOptions {
  handle: NativeRuntimeHandle;
  decodeTimeoutMs: number;
  /** Invoked exactly once when the lease is released. */
  release(outcome: "healthy" | "unhealthy"): Promise<void>;
}

/**
 * Adapts one leased native handle into the scheduler-facing session seam:
 * pushVad → VadGate → VadUpdate. Decode is serialized on this session and raced
 * against decodeTimeoutMs; any failure/timeout retires the handle as unhealthy.
 */
export function createNativeRuntimeSession(
  options: NativeRuntimeSessionOptions,
): StreamingRuntimeSession {
  const gate = createVadGate();
  let windowIndex = 0;
  let speaking = false;
  let closed = false;
  let unhealthy = false;
  let decodeChain: Promise<void> = Promise.resolve();

  const markUnhealthy = () => {
    unhealthy = true;
  };

  const raceDecode = async (audio: Int16Array, prompt: string): Promise<DecodeResult> => {
    if (unhealthy || closed) {
      throw new Error("native runtime session is closed");
    }

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
      // Any decode failure/timeout retires the handle; abandon in-flight native work.
      markUnhealthy();
      void decodePromise.then(
        () => undefined,
        () => undefined,
      );
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return {
    push(frame: PcmFrame): VadUpdate {
      if (closed || unhealthy) return { speechStarted: false, speechEnded: false };

      const probs = options.handle.pushVad(frame.samples);
      let speechStarted = false;
      let speechEnded = false;

      for (let index = 0; index < probs.length; index += 1) {
        const windowStartMs = windowIndex * VAD_DEFAULTS.windowMs;
        windowIndex += 1;
        const decision = gate.push(probs[index]!, windowStartMs);

        if (decision.type === "idle") {
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
      }

      return { speechStarted, speechEnded };
    },

    decode(kind, audio, prompt) {
      void kind;
      if (closed || unhealthy) {
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
      await options.release(unhealthy ? "unhealthy" : "healthy");
    },
  };
}
