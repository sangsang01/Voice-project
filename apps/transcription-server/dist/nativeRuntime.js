import { posix } from "node:path";
import { fallbackWhisperLanguages, mapDetectedLanguage, pinnedWhisperLanguage } from "./languageMap.js";
import { createVadGate, VAD_DEFAULTS } from "./vadGate.js";
const DEFAULT_DECODE_TIMEOUT_MS = 30_000;
const SILENT_VAD = { speechStarted: false, speechEnded: false, maxDuration: false };
export function createNativeStreamingRuntime(options) {
    if (options.modelPath.includes(".en")) {
        throw new Error("VOICE_MODEL_PATH must reference a multilingual model");
    }
    const decodeTimeoutMs = options.decodeTimeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS;
    const modelName = posix.basename(options.modelPath.replace(/\\/g, "/"));
    const backend = options.useGpu ? "cuda" : "cpu";
    let addon;
    let handle;
    let loadCount = 0;
    let activeSession;
    let closed = false;
    let readyPromise;
    function makeHandle() {
        if (options.createHandle)
            return options.createHandle();
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
    async function ensureHandle() {
        if (closed)
            throw new Error("native runtime is closed");
        if (handle)
            return;
        const next = makeHandle();
        handle = next;
        try {
            await next.warmup();
            if (closed) {
                next.close();
                handle = undefined;
                throw new Error("native runtime is closed");
            }
            loadCount += 1;
        }
        catch (error) {
            next.close();
            if (handle === next)
                handle = undefined;
            throw error;
        }
    }
    async function ready() {
        readyPromise ??= ensureHandle();
        try {
            await readyPromise;
        }
        catch (error) {
            readyPromise = undefined;
            throw error;
        }
    }
    async function recycle() {
        handle?.close();
        handle = undefined;
        readyPromise = undefined;
        await ready();
    }
    async function open(request) {
        await ready();
        if (activeSession)
            throw new Error("native runtime is busy");
        const gate = createVadGate();
        let windowIndex = 0;
        let reportedSpeaking = false;
        const language = pinnedWhisperLanguage(request.candidateLanguages);
        async function decodeOnce(audio, decodeLanguage) {
            if (!handle)
                throw new Error("native runtime handle is missing");
            let timer;
            const decodePromise = handle.decode(audio, "", decodeLanguage);
            const timeoutPromise = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("TIMEOUT")), decodeTimeoutMs);
            });
            void decodePromise.catch(() => undefined);
            void timeoutPromise.catch(() => undefined);
            try {
                return await Promise.race([decodePromise, timeoutPromise]);
            }
            finally {
                if (timer !== undefined)
                    clearTimeout(timer);
            }
        }
        const session = {
            push(frame) {
                if (closed || activeSession !== session || !handle)
                    return SILENT_VAD;
                const samples = new Int16Array(frame.samples);
                const probabilities = handle.pushVad(samples);
                const update = { speechStarted: false, speechEnded: false, maxDuration: false };
                for (let index = 0; index < probabilities.length; index += 1) {
                    const windowStartMs = windowIndex * VAD_DEFAULTS.windowMs;
                    windowIndex += 1;
                    const decision = gate.push(probabilities[index], windowStartMs);
                    if (decision.type === "speaking") {
                        if (!reportedSpeaking) {
                            update.speechStarted = true;
                            reportedSpeaking = true;
                        }
                        continue;
                    }
                    if (decision.type !== "flush")
                        continue;
                    if (!reportedSpeaking)
                        update.speechStarted = true;
                    reportedSpeaking = false;
                    if (decision.reason === "silence") {
                        update.speechEnded = true;
                    }
                    if (decision.reason === "max-duration") {
                        update.maxDuration = true;
                    }
                }
                return update;
            },
            async decode(_kind, audio, _prompt) {
                try {
                    let result = await decodeOnce(audio, language);
                    if (!language) {
                        const mapped = mapDetectedLanguage(result.language, result.languageProbability, request.candidateLanguages);
                        if (mapped.tag === "und") {
                            const fallback = fallbackWhisperLanguages(result.language, request.candidateLanguages)[0];
                            if (fallback) {
                                try {
                                    const retried = await decodeOnce(audio, fallback);
                                    result = { ...retried, language: fallback, languageProbability: 1 };
                                }
                                catch {
                                    // Keep the auto-detect result. A forced-language retry that
                                    // fails or hangs the native context must not drop the caption
                                    // or pin later utterances to that language.
                                }
                            }
                        }
                    }
                    return result;
                }
                catch (error) {
                    // Timeout and whisper_full failures both leave ggml state unusable.
                    // Reload once so the next utterance can decode instead of failing
                    // silently for the rest of the session.
                    await recycle();
                    throw error;
                }
            },
            close() {
                if (activeSession !== session)
                    return Promise.resolve();
                activeSession = undefined;
                gate.reset();
                if (!closed)
                    handle?.reset();
                return Promise.resolve();
            },
        };
        activeSession = session;
        return session;
    }
    async function close() {
        if (closed)
            return;
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
