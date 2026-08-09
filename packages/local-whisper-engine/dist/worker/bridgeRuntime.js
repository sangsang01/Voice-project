import { loadModelAsset } from "../cache/modelAssets.js";
import { LOCAL_MODEL } from "../modelManifest.js";
// BridgeModule/BridgeInstance are imported directly from wasm/whisper-bridge.d.ts
// (as WhisperBridgeModule/WhisperBridgeInstance) rather than redeclared here,
// so a signature change in that .d.ts (which itself must track native/bridge.cpp)
// is caught by the typechecker at this call site instead of silently drifting
// behind a same-shaped local copy.
const VAD_MEMFS_PATH = "/silero.bin";
function threadCount() {
    // The bridge already runs off the UI thread. With the current Emscripten
    // pthread build, nested workers stall inside whisper_full() after VAD flush
    // in Chromium; single-thread inference completes the same real WASM path.
    return 1;
}
export function createBridgeRuntime() {
    let module;
    let bridge;
    let samplesPtr = 0;
    let samplesCapacity = 0;
    const ensureSampleBuffer = (count) => {
        if (!module)
            throw new Error("whisper bridge is not loaded");
        if (count > samplesCapacity) {
            if (samplesPtr)
                module._free(samplesPtr);
            samplesPtr = module._malloc(count * 4);
            samplesCapacity = count;
        }
        return samplesPtr;
    };
    const writeSamples = (samples) => {
        if (!module)
            throw new Error("whisper bridge is not loaded");
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
            if (signal.aborted)
                throw new DOMException("Aborted", "AbortError");
            // No cast needed: the dynamic import()'s type comes straight from
            // wasm/whisper-bridge.d.ts (its default export is typed as
            // `() => Promise<WhisperBridgeModule>`), so `factory.default()`
            // already resolves to `WhisperBridgeModule` and this stays a live
            // typecheck against that seam rather than an `as unknown as` escape
            // hatch that would hide drift if the .d.ts changes later.
            const factory = await import("../../wasm/whisper-bridge.js");
            module = await factory.default();
            if (signal.aborted)
                throw new DOMException("Aborted", "AbortError");
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
            if (signal.aborted)
                throw new DOMException("Aborted", "AbortError");
            const modelPtr = module._malloc(weights.byteLength);
            module.HEAPU8.set(new Uint8Array(weights), modelPtr);
            bridge = new module.WhisperBridge();
            let initialised = false;
            try {
                initialised = bridge.init(modelPtr, weights.byteLength, VAD_MEMFS_PATH, threadCount());
            }
            finally {
                // whisper.cpp copies the model bytes into its own ggml tensor
                // allocations while loading (vendor/whisper.cpp/src/whisper.cpp:3668-3703,
                // memcpy(output, buf->buffer + buf->current_offset, size_to_copy)) and
                // keeps no reference to modelPtr afterward. So modelPtr is dead the
                // instant init() returns -- on success as much as on failure -- and
                // nothing else in this module ever frees it (dispose() only frees
                // samplesPtr). Free it unconditionally here, in a finally, so every
                // exit from init() (success, `false`, or a thrown error) reclaims the
                // ~31MB buffer instead of leaking it for the lifetime of the module.
                module._free(modelPtr);
            }
            if (!initialised) {
                bridge = undefined;
                throw new Error("Failed to initialise the whisper.cpp bridge.");
            }
            onProgress(1);
        },
        vadProbs(samples) {
            if (!module || !bridge)
                throw new Error("whisper bridge is not loaded");
            const pointer = writeSamples(samples);
            const count = bridge.vadProbs(pointer, samples.length);
            if (count <= 0)
                return new Float32Array(0);
            const probsPtr = bridge.probsPtr();
            // Copied, not a view: whisper.cpp resizes the vector backing probsPtr()
            // on every vadProbs() call, so a live view would silently go stale (or
            // point at freed/reused memory) the moment the next chunk arrives.
            // Same byte-offset -> float-index conversion as writeSamples() above.
            return module.HEAPF32.slice(probsPtr >> 2, (probsPtr >> 2) + count);
        },
        vadReset() {
            if (!bridge)
                throw new Error("whisper bridge is not loaded");
            bridge.vadReset();
        },
        async transcribe(samples, signal) {
            if (!module || !bridge)
                throw new Error("whisper bridge is not loaded");
            if (signal.aborted)
                throw new DOMException("Aborted", "AbortError");
            const pointer = writeSamples(samples);
            const result = bridge.transcribe(pointer, samples.length, threadCount());
            if (signal.aborted)
                throw new DOMException("Aborted", "AbortError");
            return { ...result, text: result.text.trim() };
        },
        async dispose() {
            bridge?.release();
            bridge = undefined;
            if (module && samplesPtr)
                module._free(samplesPtr);
            samplesPtr = 0;
            samplesCapacity = 0;
            module = undefined;
        },
    };
}
