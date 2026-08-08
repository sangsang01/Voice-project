#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdint>
#include <string>
#include <vector>

#include "whisper.h"

// Inference only. Every policy decision (when to flush, how to label a
// language, how to buffer) lives in TypeScript so it stays unit-testable
// without a WASM toolchain.
class WhisperBridge {
public:
    // The 31 MB whisper model is passed as a pointer into the WASM heap and
    // adopted in place. The 885 kB VAD model is read from a MEMFS path the
    // caller wrote first: whisper_vad_init_with_params needs a
    // whisper_model_loader, and at this size the MEMFS copy is not worth the
    // extra glue.
    bool init(std::uintptr_t modelPtr, std::size_t modelLen, const std::string & vadPath, int nThreads) {
        release();

        whisper_context_params cparams = whisper_context_default_params();
        cparams.use_gpu = false;
        ctx = whisper_init_from_buffer_with_params(reinterpret_cast<void *>(modelPtr), modelLen, cparams);
        if (ctx == nullptr) {
            return false;
        }

        whisper_vad_context_params vparams = whisper_vad_default_context_params();
        vparams.n_threads = nThreads;
        vparams.use_gpu = false;
        vctx = whisper_vad_init_from_file_with_params(vadPath.c_str(), vparams);
        if (vctx == nullptr) {
            release();
            return false;
        }
        return true;
    }

    // Keeps Silero's recurrent state across calls -- this is a continuous
    // microphone stream, not independent clips. Returns the probability count;
    // read the values from probsPtr().
    int vadProbs(std::uintptr_t samplesPtr, std::size_t sampleCount) {
        if (vctx == nullptr) {
            return 0;
        }
        const float * samples = reinterpret_cast<const float *>(samplesPtr);
        if (!whisper_vad_detect_speech_no_reset(vctx, samples, static_cast<int>(sampleCount))) {
            return 0;
        }
        return whisper_vad_n_probs(vctx);
    }

    std::uintptr_t probsPtr() const {
        return vctx == nullptr ? 0 : reinterpret_cast<std::uintptr_t>(whisper_vad_probs(vctx));
    }

    void vadReset() {
        if (vctx != nullptr) {
            whisper_vad_reset_state(vctx);
        }
    }

    emscripten::val transcribe(std::uintptr_t samplesPtr, std::size_t sampleCount, int nThreads) {
        emscripten::val result = emscripten::val::object();
        result.set("text", std::string(""));
        result.set("language", std::string("und"));
        result.set("languageProbability", 0.0f);
        if (ctx == nullptr) {
            return result;
        }

        whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        params.n_threads         = nThreads;
        params.translate         = false;  // keep the spoken language as-is
        params.language          = nullptr; // auto-detect; read back via whisper_full_lang_id
        params.detect_language   = false;
        params.print_progress    = false;
        params.print_realtime    = false;
        params.print_timestamps  = false;
        params.single_segment    = true;   // one utterance in, one segment out
        params.no_context        = true;   // utterances are independent
        params.vad               = false;  // TypeScript already picked the boundaries

        const float * samples = reinterpret_cast<const float *>(samplesPtr);
        if (whisper_full(ctx, params, samples, static_cast<int>(sampleCount)) != 0) {
            return result;
        }

        std::string text;
        const int n = whisper_full_n_segments(ctx);
        for (int i = 0; i < n; ++i) {
            text += whisper_full_get_segment_text(ctx, i);
        }

        const int langId = whisper_full_lang_id(ctx);
        result.set("text", text);
        result.set("language", std::string(langId < 0 ? "und" : whisper_lang_str(langId)));
        result.set("languageProbability", langId < 0 ? 0.0f : 1.0f);
        return result;
    }

    void release() {
        if (vctx != nullptr) { whisper_vad_free(vctx); vctx = nullptr; }
        if (ctx  != nullptr) { whisper_free(ctx);      ctx  = nullptr; }
    }

    ~WhisperBridge() { release(); }

private:
    whisper_context     * ctx  = nullptr;
    whisper_vad_context * vctx = nullptr;
};

EMSCRIPTEN_BINDINGS(whisper_bridge) {
    emscripten::class_<WhisperBridge>("WhisperBridge")
        .constructor<>()
        .function("init",       &WhisperBridge::init)
        .function("vadProbs",   &WhisperBridge::vadProbs)
        .function("probsPtr",   &WhisperBridge::probsPtr)
        .function("vadReset",   &WhisperBridge::vadReset)
        .function("transcribe", &WhisperBridge::transcribe)
        .function("release",    &WhisperBridge::release);
}
