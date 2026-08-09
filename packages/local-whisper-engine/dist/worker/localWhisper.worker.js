import { mapDetectedLanguage } from "../segmentation/languageMap.js";
import { createBridgeRuntime } from "./bridgeRuntime.js";
import { createVadGate, VAD_DEFAULTS } from "./vadGate.js";
const FRAME_SAMPLES = 320;
const VAD_WINDOW_SAMPLES = 512;
const SAMPLE_RATE = 16_000;
export function createWorkerController(runtime, post, options = {}) {
    const maxBufferedFrames = options.maxBufferedFrames ?? 3000;
    const vadConfig = { ...VAD_DEFAULTS, ...options.vad };
    const now = options.now ?? (() => performance.now());
    let loadAbort = new AbortController();
    let active;
    let commandQueue = Promise.resolve();
    let inferenceToken = 0;
    const emit = (session, event) => {
        post({
            type: "event",
            event: { ...event, sessionId: session.request.sessionId, sequence: session.sequence++ },
        });
    };
    const emitState = (session, state) => emit(session, { type: "state", state });
    /** int16 frame -> normalised float32, the format both whisper and Silero want. */
    const toFloat = (frame) => {
        const out = new Float32Array(frame.samples.length);
        for (let index = 0; index < frame.samples.length; index += 1) {
            out[index] = frame.samples[index] / 0x8000;
        }
        return out;
    };
    const concat = (chunks) => {
        let total = 0;
        for (const chunk of chunks)
            total += chunk.length;
        const merged = new Float32Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }
        return merged;
    };
    const sampleToMs = (sample) => (sample * 1000) / SAMPLE_RATE;
    const audioEndSample = (session) => session.audioStartSample + session.audioSampleCount;
    const audioEndMs = (session) => sampleToMs(audioEndSample(session));
    /** Slices the session buffer for [startMs, endMs), clamped to what we still hold. */
    const sliceAudio = (session, startMs, endMs) => {
        const all = concat(session.audio);
        const requestedStart = Math.floor((startMs / 1000) * SAMPLE_RATE);
        const requestedEnd = Math.ceil((endMs / 1000) * SAMPLE_RATE);
        const actualStart = Math.max(session.audioStartSample, requestedStart);
        const actualEnd = Math.min(audioEndSample(session), requestedEnd);
        const from = actualStart - session.audioStartSample;
        const to = actualEnd - session.audioStartSample;
        return {
            samples: from >= to ? new Float32Array(0) : all.slice(from, to),
            startMs: sampleToMs(actualStart),
            endMs: sampleToMs(actualEnd),
        };
    };
    /** Drops audio older than the flushed utterance so memory stays bounded. */
    const trimAudio = (session, upToMs) => {
        const all = concat(session.audio);
        const targetSample = Math.floor((upToMs / 1000) * SAMPLE_RATE);
        const cut = Math.min(all.length, Math.max(0, targetSample - session.audioStartSample));
        if (cut <= 0)
            return;
        const remaining = all.slice(cut);
        session.audio = remaining.length > 0 ? [remaining] : [];
        session.audioStartSample += cut;
        session.audioSampleCount -= cut;
        session.discardedCreditSamples += cut;
        const releasedFrames = Math.min(session.bufferedFrames, Math.floor(session.discardedCreditSamples / FRAME_SAMPLES));
        if (releasedFrames > 0) {
            session.discardedCreditSamples -= releasedFrames * FRAME_SAMPLES;
            session.bufferedFrames -= releasedFrames;
            post({ type: "credit", sessionId: session.request.sessionId, frames: releasedFrames });
        }
    };
    const clearBufferedWork = (session, releaseCredits = false) => {
        if (releaseCredits && session.bufferedFrames > 0) {
            post({ type: "credit", sessionId: session.request.sessionId, frames: session.bufferedFrames });
        }
        session.audio = [];
        session.audioSampleCount = 0;
        session.discardedCreditSamples = 0;
        session.bufferedFrames = 0;
        session.vadQueue = new Float32Array(0);
        session.pendingMaxFlush = undefined;
        session.gate.reset();
    };
    const failSession = (session, error) => {
        if (session.terminal)
            return;
        session.terminal = true;
        session.abort.abort();
        clearBufferedWork(session);
        emit(session, {
            type: "error",
            code: "INTERNAL",
            fatal: true,
            message: error instanceof Error ? error.message : "Local transcription failed",
        });
        emitState(session, "stopped");
    };
    const resetNativeVad = (session) => {
        try {
            runtime.vadReset();
            return true;
        }
        catch (error) {
            failSession(session, error);
            return false;
        }
    };
    const transcribeUtterance = async (session, startMs, endMs) => {
        const { samples, startMs: actualStartMs, endMs: actualEndMs } = sliceAudio(session, startMs, endMs);
        if (samples.length === 0 || session.terminal)
            return;
        const startedAt = now();
        const token = ++inferenceToken;
        post({
            type: "inference.started",
            sessionId: session.request.sessionId,
            token,
            audioDurationMs: (samples.length * 1000) / SAMPLE_RATE,
        });
        try {
            let result;
            try {
                // The Embind call inside runtime.transcribe() is synchronous. The main-window
                // engine supervises this lifecycle because a timer on this worker's event loop
                // cannot run while whisper_full() is blocked.
                result = await runtime.transcribe(samples, session.abort.signal);
            }
            finally {
                post({ type: "inference.finished", sessionId: session.request.sessionId, token });
            }
            if (session.terminal || session.abort.signal.aborted)
                return;
            const elapsedMs = now() - startedAt;
            const audioDurationMs = actualEndMs - actualStartMs;
            session.consecutiveSlowTranscriptions = elapsedMs > audioDurationMs
                ? session.consecutiveSlowTranscriptions + 1
                : 0;
            if (session.consecutiveSlowTranscriptions === 3) {
                emit(session, {
                    type: "warning",
                    code: "DEGRADED_PERFORMANCE",
                    message: "Local transcription is slower than realtime.",
                });
            }
            const text = result.text.trim();
            if (text.length > 0) {
                const ordinal = session.ordinal++;
                const segment = {
                    id: `${session.request.sessionId}:${ordinal}`,
                    ordinal,
                    revision: 1,
                    startMs: actualStartMs,
                    endMs: actualEndMs,
                    text,
                    language: mapDetectedLanguage(result.language, result.languageProbability, session.request.candidateLanguages),
                    isFinal: true,
                };
                emit(session, { type: "segment.upsert", segment });
            }
        }
        catch (error) {
            if (session.terminal || session.abort.signal.aborted)
                return;
            failSession(session, error);
            return;
        }
    };
    const finalizeUtterance = async (session, decision, trimThroughMs, endMs = decision.endMs) => {
        if (!resetNativeVad(session))
            return false;
        await transcribeUtterance(session, decision.startMs, endMs);
        if (session.terminal)
            return false;
        trimAudio(session, trimThroughMs);
        return true;
    };
    /**
     * Silero consumes fixed 512-sample windows, but microphone frames are 320
     * samples, so whatever does not fill a window is carried into the next push.
     */
    const runVad = async (session, chunk) => {
        session.vadQueue = concat([session.vadQueue, chunk]);
        while (!session.terminal) {
            if (session.pendingMaxFlush) {
                const decision = session.pendingMaxFlush;
                if (audioEndMs(session) < decision.endMs)
                    return;
                session.pendingMaxFlush = undefined;
                const nextStartMs = decision.endMs - (2 * vadConfig.speechPadMs);
                if (!await finalizeUtterance(session, decision, nextStartMs))
                    return;
                continue;
            }
            if (session.vadQueue.length < VAD_WINDOW_SAMPLES)
                return;
            const window = session.vadQueue.slice(0, VAD_WINDOW_SAMPLES);
            session.vadQueue = session.vadQueue.slice(VAD_WINDOW_SAMPLES);
            let probs;
            try {
                probs = runtime.vadProbs(window);
            }
            catch (error) {
                failSession(session, error);
                return;
            }
            for (let index = 0; index < probs.length; index += 1) {
                const windowStartMs = (session.windowIndex++ * VAD_WINDOW_SAMPLES * 1000) / SAMPLE_RATE;
                const decision = session.gate.push(probs[index], windowStartMs);
                if (decision.type === "idle") {
                    // Pure idle needs only enough pre-roll for speech beginning in the
                    // next VAD window. A qualifying sub-minimum run carries its exact
                    // padded onset so trimming cannot cross audio it may still need.
                    const retainFromMs = decision.retainFromMs
                        ?? (windowStartMs + vadConfig.windowMs - vadConfig.speechPadMs);
                    trimAudio(session, retainFromMs);
                    continue;
                }
                if (decision.type !== "flush")
                    continue;
                if (decision.reason === "max-duration") {
                    session.pendingMaxFlush = decision;
                    break;
                }
                if (!await finalizeUtterance(session, decision, decision.endMs))
                    return;
            }
        }
    };
    const handleMessage = async (message) => {
        switch (message.type) {
            case "prepare": {
                loadAbort.abort();
                loadAbort = new AbortController();
                try {
                    await runtime.load({ onProgress: (progress) => post({ type: "progress", requestId: message.requestId, progress }) }, loadAbort.signal);
                    post({ type: "prepared", requestId: message.requestId });
                }
                catch (error) {
                    if (!loadAbort.signal.aborted) {
                        post({ type: "prepare.error", requestId: message.requestId, message: error instanceof Error ? error.message : String(error) });
                    }
                }
                return;
            }
            case "open": {
                active?.abort.abort();
                active = {
                    request: message.request,
                    abort: new AbortController(),
                    sequence: 0,
                    ordinal: 0,
                    terminal: false,
                    audio: [],
                    audioStartSample: 0,
                    audioSampleCount: 0,
                    discardedCreditSamples: 0,
                    bufferedFrames: 0,
                    consecutiveSlowTranscriptions: 0,
                    gate: createVadGate(vadConfig),
                    vadQueue: new Float32Array(0),
                    windowIndex: 0,
                };
                if (!resetNativeVad(active))
                    return;
                emitState(active, "listening");
                return;
            }
            case "push": {
                if (!active || active.terminal || active.request.sessionId !== message.sessionId)
                    return;
                if (active.bufferedFrames >= maxBufferedFrames) {
                    emit(active, { type: "warning", code: "AUDIO_GAP", message: "Local audio buffer is full." });
                    return;
                }
                const chunk = toFloat(message.frame);
                active.audio.push(chunk);
                active.audioSampleCount += chunk.length;
                active.bufferedFrames += 1;
                await runVad(active, chunk);
                return;
            }
            case "stop": {
                if (!active || active.terminal || active.request.sessionId !== message.sessionId)
                    return;
                emitState(active, "draining");
                const availableEndMs = audioEndMs(active);
                if (active.pendingMaxFlush) {
                    const decision = active.pendingMaxFlush;
                    active.pendingMaxFlush = undefined;
                    active.gate.reset();
                    active.vadQueue = new Float32Array(0);
                    await finalizeUtterance(active, decision, availableEndMs, availableEndMs);
                }
                else {
                    const decision = active.gate.flushPending(availableEndMs);
                    if (decision.type === "flush") {
                        await finalizeUtterance(active, decision, availableEndMs, Math.min(decision.endMs, availableEndMs));
                    }
                    else {
                        resetNativeVad(active);
                    }
                }
                if (!active.terminal) {
                    // A normal stop is terminal for this session, so release any frames
                    // that did not belong to a transcribed utterance (silence or a
                    // sub-minimum speech run) and drop every retained audio/VAD array.
                    // Flush paths already credited discarded frames, making the
                    // remaining bufferedFrames count exactly the uncredited remainder.
                    clearBufferedWork(active, true);
                    active.terminal = true;
                    emitState(active, "stopped");
                }
                return;
            }
            case "cancel": {
                if (!active || active.terminal || active.request.sessionId !== message.sessionId)
                    return;
                active.gate.reset();
                if (!resetNativeVad(active))
                    return;
                active.terminal = true;
                active.abort.abort();
                clearBufferedWork(active);
                emitState(active, "stopped");
                return;
            }
            case "dispose":
                loadAbort.abort();
                active?.abort.abort();
                if (active)
                    active.terminal = true;
                await runtime.dispose();
        }
    };
    return {
        handle(message) {
            const result = commandQueue.then(() => handleMessage(message));
            commandQueue = result.catch(() => undefined);
            return result;
        },
        async dispose() {
            loadAbort.abort();
            active?.abort.abort();
            if (active)
                active.terminal = true;
            await runtime.dispose();
        },
    };
}
if (typeof self !== "undefined" && typeof self.postMessage === "function") {
    const workerScope = globalThis;
    const controller = createWorkerController(createBridgeRuntime(), (event) => workerScope.postMessage(event));
    workerScope.onmessage = (event) => { void controller.handle(event.data); };
}
