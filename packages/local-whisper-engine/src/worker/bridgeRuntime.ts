import { loadModelAsset } from "../cache/modelAssets.js";
import { LOCAL_MODEL } from "../modelManifest.js";

export interface TranscribeResult {
  text: string;
  language: string;
  languageProbability: number;
}

/**
 * The seam the worker controller is tested against. Unit tests substitute a
 * fake, so none of them need a WASM toolchain.
 */
export interface WhisperRuntime {
  load(options: { onProgress(fraction: number): void }, signal: AbortSignal): Promise<void>;
  /** One probability per 512-sample window; Silero state persists across calls. */
  vadProbs(samples: Float32Array): Float32Array;
  transcribe(samples: Float32Array, signal: AbortSignal): Promise<TranscribeResult>;
  dispose(): Promise<void>;
}

interface BridgeModule {
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  FS: { writeFile(path: string, data: Uint8Array): void };
  WhisperBridge: new () => BridgeInstance;
}

interface BridgeInstance {
  init(modelPtr: number, modelLen: number, vadPath: string, nThreads: number): boolean;
  vadProbs(samplesPtr: number, sampleCount: number): number;
  probsPtr(): number;
  vadReset(): void;
  transcribe(samplesPtr: number, sampleCount: number, nThreads: number): TranscribeResult;
  release(): void;
}

const VAD_MEMFS_PATH = "/silero.bin";

function threadCount(): number {
  const cores = typeof navigator === "undefined" ? 4 : (navigator.hardwareConcurrency ?? 4);
  // Matches PTHREAD_POOL_SIZE in native/CMakeLists.txt; asking for more threads
  // than the pool has just blocks.
  return Math.max(1, Math.min(4, cores));
}

export function createBridgeRuntime(): WhisperRuntime {
  let module: BridgeModule | undefined;
  let bridge: BridgeInstance | undefined;
  let samplesPtr = 0;
  let samplesCapacity = 0;

  const ensureSampleBuffer = (count: number): number => {
    if (!module) throw new Error("whisper bridge is not loaded");
    if (count > samplesCapacity) {
      if (samplesPtr) module._free(samplesPtr);
      samplesPtr = module._malloc(count * 4);
      samplesCapacity = count;
    }
    return samplesPtr;
  };

  const writeSamples = (samples: Float32Array): number => {
    if (!module) throw new Error("whisper bridge is not loaded");
    const pointer = ensureSampleBuffer(samples.length);
    // `pointer` is a byte offset into the WASM heap (as every Emscripten
    // pointer is), but HEAPF32 is a *float* view over that same heap, so
    // indexing it takes a float index, not a byte offset. Dividing by 4
    // (the byte width of a float32) converts one to the other; `>> 2` is
    // that same division done as an integer right-shift, which is exact
    // here because `_malloc` always returns addresses aligned to at least
    // 4 bytes. Read `module.HEAPF32` fresh on every call (never cache it
    // in a closure variable) -- see the note on ALLOW_MEMORY_GROWTH below.
    module.HEAPF32.set(samples, pointer >> 2);
    return pointer;
  };

  return {
    async load({ onProgress }, signal) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");

      const factory = (await import("../../wasm/whisper-bridge.js")) as unknown as {
        default: () => Promise<BridgeModule>;
      };
      module = await factory.default();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");

      // The VAD model is ~885kB, so a MEMFS copy costs nothing and avoids
      // hand-rolling a whisper_model_loader. The 31MB whisper model is adopted
      // straight from the heap instead.
      const vad = await loadModelAsset(LOCAL_MODEL.vad, {
        onProgress: (fraction) => onProgress(fraction * 0.05),
      });
      module.FS.writeFile(VAD_MEMFS_PATH, new Uint8Array(vad));

      const weights = await loadModelAsset(LOCAL_MODEL.whisper, {
        onProgress: (fraction) => onProgress(0.05 + fraction * 0.95),
      });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");

      const modelPtr = module._malloc(weights.byteLength);
      module.HEAPU8.set(new Uint8Array(weights), modelPtr);

      bridge = new module.WhisperBridge();
      if (!bridge.init(modelPtr, weights.byteLength, VAD_MEMFS_PATH, threadCount())) {
        module._free(modelPtr);
        bridge = undefined;
        throw new Error("Failed to initialise the whisper.cpp bridge.");
      }
      onProgress(1);
    },

    vadProbs(samples) {
      if (!module || !bridge) throw new Error("whisper bridge is not loaded");
      const pointer = writeSamples(samples);
      const count = bridge.vadProbs(pointer, samples.length);
      if (count <= 0) return new Float32Array(0);
      const probsPtr = bridge.probsPtr();
      // Copied, not a view: whisper.cpp resizes the vector backing probsPtr()
      // on every vadProbs() call, so a live view would silently go stale (or
      // point at freed/reused memory) the moment the next chunk arrives.
      // Same byte-offset -> float-index conversion as writeSamples() above.
      return module.HEAPF32.slice(probsPtr >> 2, (probsPtr >> 2) + count);
    },

    async transcribe(samples, signal) {
      if (!module || !bridge) throw new Error("whisper bridge is not loaded");
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const pointer = writeSamples(samples);
      const result = bridge.transcribe(pointer, samples.length, threadCount());
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return { ...result, text: result.text.trim() };
    },

    async dispose() {
      bridge?.release();
      bridge = undefined;
      if (module && samplesPtr) module._free(samplesPtr);
      samplesPtr = 0;
      samplesCapacity = 0;
      module = undefined;
    },
  };
}
