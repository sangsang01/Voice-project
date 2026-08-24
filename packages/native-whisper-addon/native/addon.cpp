#ifndef NAPI_VERSION
#define NAPI_VERSION 8
#endif

#include <napi.h>
#include <whisper.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr int kVadWindowSamples = 512;
constexpr float kInt16Scale = 32768.0f;

bool ContainsEnglishOnlyMarker(const std::string & path) {
  return path.find(".en") != std::string::npos;
}

void Int16ToFloat(const int16_t * input, size_t count, float * output) {
  for (size_t i = 0; i < count; ++i) {
    output[i] = static_cast<float>(input[i]) / kInt16Scale;
  }
}

bool AbortIfRequested(void * userData) {
  const auto * aborting = static_cast<const std::atomic<bool> *>(userData);
  return aborting != nullptr && aborting->load(std::memory_order_acquire);
}

int AudioCtxForSamples(whisper_context * ctx, int nSamples) {
  const int maxCtx = whisper_n_audio_ctx(ctx);
  if (nSamples <= 0 || maxCtx <= 0) {
    return 0;
  }
  // 1500 encoder frames cover 30s. Scale to the clip and pad so conv/pooling
  // does not clip the tail. Leaving audio_ctx at 0 would encode a full 30s
  // spectrogram on every 750ms provisional.
  const int computed =
      static_cast<int>(std::ceil(static_cast<double>(nSamples) * 1500.0 / (16000.0 * 30.0))) + 32;
  // Short provisionals need enough encoder frames for conv/pooling; 32 was
  // too small and made whisper_full fail after the first successful clip.
  return std::max(150, std::min(maxCtx, computed));
}

void WhisperLogFilter(enum ggml_log_level level, const char * text, void * /*userData*/) {
  if (level >= GGML_LOG_LEVEL_ERROR && text != nullptr) {
    fputs(text, stderr);
  }
}

struct DecodeResult {
  std::string text;
  std::string language = "und";
  double languageProbability = 0.0;
  double startMs = 0.0;
  double endMs = 0.0;
};

}  // namespace

class WhisperRuntimeWrap : public Napi::ObjectWrap<WhisperRuntimeWrap> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  WhisperRuntimeWrap(const Napi::CallbackInfo & info);
  ~WhisperRuntimeWrap() override;

  DecodeResult RunDecode(const std::vector<int16_t> & samples, const std::string & prompt,
                         const std::string & language);

 private:
  static Napi::FunctionReference constructor;
  static Napi::Value CreateRuntime(const Napi::CallbackInfo & info);

  Napi::Value PushVad(const Napi::CallbackInfo & info);
  Napi::Value Decode(const Napi::CallbackInfo & info);
  Napi::Value Warmup(const Napi::CallbackInfo & info);
  Napi::Value Reset(const Napi::CallbackInfo & info);
  Napi::Value Close(const Napi::CallbackInfo & info);

  void FreeResources();
  Napi::Value QueueDecode(const Napi::CallbackInfo & info, std::vector<int16_t> samples,
                          std::string prompt, std::string language, bool warmup);

  std::mutex decodeMutex_;
  std::mutex stateMutex_;
  whisper_context * ctx_ = nullptr;
  whisper_vad_context * vctx_ = nullptr;
  std::vector<float> vadCarry_;
  int threads_ = 1;
  bool closed_ = false;
  std::atomic<bool> abortRequested_{false};
};

Napi::FunctionReference WhisperRuntimeWrap::constructor;

class DecodeWorker : public Napi::AsyncWorker {
 public:
  DecodeWorker(Napi::Env env, Napi::Object handle, std::vector<int16_t> samples, std::string prompt,
               std::string language, bool warmup)
      : Napi::AsyncWorker(env),
        deferred_(Napi::Promise::Deferred::New(env)),
        handle_(Napi::Persistent(handle)),
        wrap_(WhisperRuntimeWrap::Unwrap(handle)),
        samples_(std::move(samples)),
        prompt_(std::move(prompt)),
        language_(std::move(language)),
        warmup_(warmup) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

 protected:
  void Execute() override {
    try {
      result_ = wrap_->RunDecode(samples_, prompt_, language_);
    } catch (const std::exception & error) {
      SetError(error.what());
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    if (warmup_) {
      deferred_.Resolve(env.Undefined());
      return;
    }
    Napi::Object object = Napi::Object::New(env);
    object.Set("text", result_.text);
    object.Set("language", result_.language);
    object.Set("languageProbability", result_.languageProbability);
    object.Set("startMs", result_.startMs);
    object.Set("endMs", result_.endMs);
    deferred_.Resolve(object);
  }

  void OnError(const Napi::Error & error) override { deferred_.Reject(error.Value()); }

 private:
  Napi::Promise::Deferred deferred_;
  Napi::ObjectReference handle_;
  WhisperRuntimeWrap * wrap_;
  std::vector<int16_t> samples_;
  std::string prompt_;
  std::string language_;
  bool warmup_ = false;
  DecodeResult result_{};
};

Napi::Object WhisperRuntimeWrap::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "WhisperRuntime",
                                    {
                                        InstanceMethod("pushVad", &WhisperRuntimeWrap::PushVad),
                                        InstanceMethod("decode", &WhisperRuntimeWrap::Decode),
                                        InstanceMethod("warmup", &WhisperRuntimeWrap::Warmup),
                                        InstanceMethod("reset", &WhisperRuntimeWrap::Reset),
                                        InstanceMethod("close", &WhisperRuntimeWrap::Close),
                                    });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();
  exports.Set("createRuntime", Napi::Function::New(env, CreateRuntime));
  return exports;
}

Napi::Value WhisperRuntimeWrap::CreateRuntime(const Napi::CallbackInfo & info) {
  Napi::EscapableHandleScope scope(info.Env());
  std::vector<napi_value> args;
  if (info.Length() > 0) {
    args.push_back(info[0]);
  }
  return scope.Escape(constructor.New(args));
}

WhisperRuntimeWrap::WhisperRuntimeWrap(const Napi::CallbackInfo & info)
    : Napi::ObjectWrap<WhisperRuntimeWrap>(info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "createRuntime(options) requires an options object")
        .ThrowAsJavaScriptException();
    return;
  }

  Napi::Object options = info[0].As<Napi::Object>();
  if (!options.Get("modelPath").IsString() || !options.Get("vadModelPath").IsString()) {
    Napi::TypeError::New(env, "modelPath and vadModelPath must be strings")
        .ThrowAsJavaScriptException();
    return;
  }

  const std::string modelPath = options.Get("modelPath").As<Napi::String>().Utf8Value();
  const std::string vadModelPath = options.Get("vadModelPath").As<Napi::String>().Utf8Value();
  if (ContainsEnglishOnlyMarker(modelPath) || ContainsEnglishOnlyMarker(vadModelPath)) {
    Napi::Error::New(env, "English-only (.en) models are not supported").ThrowAsJavaScriptException();
    return;
  }

  if (options.Get("threads").IsNumber()) {
    threads_ = std::max(1, options.Get("threads").As<Napi::Number>().Int32Value());
  }
  bool useGpu = false;
  if (options.Get("useGpu").IsBoolean()) {
    useGpu = options.Get("useGpu").As<Napi::Boolean>().Value();
  }

  whisper_context_params cparams = whisper_context_default_params();
  cparams.use_gpu = useGpu;
  ctx_ = whisper_init_from_file_with_params(modelPath.c_str(), cparams);
  if (ctx_ == nullptr) {
    Napi::Error::New(env, "Failed to load whisper model").ThrowAsJavaScriptException();
    return;
  }

  whisper_vad_context_params vparams = whisper_vad_default_context_params();
  vparams.n_threads = threads_;
  vparams.use_gpu = useGpu;
  vctx_ = whisper_vad_init_from_file_with_params(vadModelPath.c_str(), vparams);
  if (vctx_ == nullptr) {
    whisper_free(ctx_);
    ctx_ = nullptr;
    Napi::Error::New(env, "Failed to load VAD model").ThrowAsJavaScriptException();
    return;
  }
}

WhisperRuntimeWrap::~WhisperRuntimeWrap() {
  abortRequested_.store(true, std::memory_order_release);
  std::lock_guard<std::mutex> decodeLock(decodeMutex_);
  std::lock_guard<std::mutex> stateLock(stateMutex_);
  FreeResources();
}

void WhisperRuntimeWrap::FreeResources() {
  if (vctx_ != nullptr) {
    whisper_vad_free(vctx_);
    vctx_ = nullptr;
  }
  if (ctx_ != nullptr) {
    whisper_free(ctx_);
    ctx_ = nullptr;
  }
  vadCarry_.clear();
  closed_ = true;
}

Napi::Value WhisperRuntimeWrap::PushVad(const Napi::CallbackInfo & info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsTypedArray() ||
      info[0].As<Napi::TypedArray>().TypedArrayType() != napi_int16_array) {
    Napi::TypeError::New(env, "pushVad(samples) requires an Int16Array").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Int16Array samples = info[0].As<Napi::Int16Array>();
  const size_t count = samples.ElementLength();
  std::vector<float> converted(count);
  Int16ToFloat(samples.Data(), count, converted.data());

  std::vector<float> probabilities;
  {
    // whisper.cpp VAD and whisper_full share ggml CPU state. If VAD runs
    // during decode, later whisper_full calls fail with "failed to decode"
    // and captions stop after the first utterance. Skip ggml VAD while a
    // decode holds decodeMutex_; samples stay in vadCarry_ until it finishes.
    std::unique_lock<std::mutex> decodeLock(decodeMutex_, std::try_to_lock);
    std::lock_guard<std::mutex> stateLock(stateMutex_);
    if (closed_ || vctx_ == nullptr) {
      Napi::Error::New(env, "runtime is closed").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    vadCarry_.insert(vadCarry_.end(), converted.begin(), converted.end());
    if (!decodeLock.owns_lock()) {
      Napi::Float32Array skipped = Napi::Float32Array::New(env, 0);
      return skipped;
    }
    while (vadCarry_.size() >= static_cast<size_t>(kVadWindowSamples)) {
      if (!whisper_vad_detect_speech_no_reset(vctx_, vadCarry_.data(), kVadWindowSamples)) {
        vadCarry_.erase(vadCarry_.begin(), vadCarry_.begin() + kVadWindowSamples);
        continue;
      }
      const int nProbs = whisper_vad_n_probs(vctx_);
      const float * probs = whisper_vad_probs(vctx_);
      if (probs != nullptr && nProbs > 0) {
        probabilities.insert(probabilities.end(), probs, probs + nProbs);
      }
      vadCarry_.erase(vadCarry_.begin(), vadCarry_.begin() + kVadWindowSamples);
    }
  }

  Napi::Float32Array result = Napi::Float32Array::New(env, probabilities.size());
  if (!probabilities.empty()) {
    std::memcpy(result.Data(), probabilities.data(), probabilities.size() * sizeof(float));
  }
  return result;
}

Napi::Value WhisperRuntimeWrap::QueueDecode(const Napi::CallbackInfo & info,
                                            std::vector<int16_t> samples, std::string prompt,
                                            std::string language, bool warmup) {
  auto * worker = new DecodeWorker(info.Env(), info.This().As<Napi::Object>(), std::move(samples),
                                   std::move(prompt), std::move(language), warmup);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value WhisperRuntimeWrap::Decode(const Napi::CallbackInfo & info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsTypedArray() ||
      info[0].As<Napi::TypedArray>().TypedArrayType() != napi_int16_array) {
    Napi::TypeError::New(env, "decode(samples, prompt) requires an Int16Array")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Int16Array samples = info[0].As<Napi::Int16Array>();
  std::vector<int16_t> copy(samples.Data(), samples.Data() + samples.ElementLength());
  std::string prompt;
  if (info.Length() >= 2 && info[1].IsString()) {
    prompt = info[1].As<Napi::String>().Utf8Value();
  }
  std::string language;
  if (info.Length() >= 3 && info[2].IsString()) {
    language = info[2].As<Napi::String>().Utf8Value();
  }
  return QueueDecode(info, std::move(copy), std::move(prompt), std::move(language), false);
}

Napi::Value WhisperRuntimeWrap::Warmup(const Napi::CallbackInfo & info) {
  return QueueDecode(info, std::vector<int16_t>(WHISPER_SAMPLE_RATE, 0), std::string(), std::string(),
                     true);
}

Napi::Value WhisperRuntimeWrap::Reset(const Napi::CallbackInfo & info) {
  abortRequested_.store(true, std::memory_order_release);
  std::lock_guard<std::mutex> stateLock(stateMutex_);
  if (!closed_ && vctx_ != nullptr) {
    whisper_vad_reset_state(vctx_);
  }
  vadCarry_.clear();
  return info.Env().Undefined();
}

Napi::Value WhisperRuntimeWrap::Close(const Napi::CallbackInfo & info) {
  abortRequested_.store(true, std::memory_order_release);
  std::lock_guard<std::mutex> decodeLock(decodeMutex_);
  std::lock_guard<std::mutex> stateLock(stateMutex_);
  FreeResources();
  return info.Env().Undefined();
}

DecodeResult WhisperRuntimeWrap::RunDecode(const std::vector<int16_t> & samples,
                                           const std::string & prompt,
                                           const std::string & language) {
  std::lock_guard<std::mutex> decodeLock(decodeMutex_);
  whisper_context * ctx = nullptr;
  int threads = 1;
  {
    std::lock_guard<std::mutex> stateLock(stateMutex_);
    if (closed_ || ctx_ == nullptr) {
      throw std::runtime_error("runtime is closed");
    }
    ctx = ctx_;
    threads = threads_;
    abortRequested_.store(false, std::memory_order_release);
  }

  std::vector<float> pcm(samples.size());
  Int16ToFloat(samples.data(), samples.size(), pcm.data());

  std::vector<whisper_token> tokens;
  whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  params.n_threads = threads;
  params.translate = false;
  params.language = language.empty() ? nullptr : language.c_str();
  params.detect_language = false;
  params.print_progress = false;
  params.print_realtime = false;
  params.print_timestamps = false;
  params.no_timestamps = true;
  params.single_segment = true;
  params.no_context = true;
  params.vad = false;
  params.audio_ctx = AudioCtxForSamples(ctx, static_cast<int>(pcm.size()));
  params.abort_callback = AbortIfRequested;
  params.abort_callback_user_data = &abortRequested_;

  if (!prompt.empty()) {
    int nTokens = whisper_tokenize(ctx, prompt.c_str(), nullptr, 0);
    if (nTokens < 0) {
      nTokens = -nTokens;
    }
    if (nTokens > 0) {
      tokens.resize(static_cast<size_t>(nTokens));
      const int written = whisper_tokenize(ctx, prompt.c_str(), tokens.data(), nTokens);
      if (written > 0) {
        params.prompt_tokens = tokens.data();
        params.prompt_n_tokens = written;
      }
    }
  }

  if (whisper_full(ctx, params, pcm.data(), static_cast<int>(pcm.size())) != 0) {
    if (abortRequested_.load(std::memory_order_acquire)) {
      throw std::runtime_error("decode aborted");
    }
    throw std::runtime_error("whisper_full failed");
  }

  DecodeResult result;
  const int nSegments = whisper_full_n_segments(ctx);
  for (int i = 0; i < nSegments; ++i) {
    const char * text = whisper_full_get_segment_text(ctx, i);
    if (text != nullptr) {
      result.text += text;
    }
  }

  const int langId = whisper_full_lang_id(ctx);
  if (langId >= 0) {
    const char * lang = whisper_lang_str(langId);
    result.language = lang == nullptr ? "und" : lang;
    result.languageProbability = 1.0;
  }

  result.startMs = 0.0;
  result.endMs = pcm.empty()
                    ? 0.0
                    : static_cast<double>(pcm.size()) * 1000.0 / static_cast<double>(WHISPER_SAMPLE_RATE);
  if (nSegments > 0) {
    const int64_t t1 = whisper_full_get_segment_t1(ctx, nSegments - 1);
    if (t1 > 0) {
      result.startMs = static_cast<double>(whisper_full_get_segment_t0(ctx, 0)) * 10.0;
      result.endMs = static_cast<double>(t1) * 10.0;
    }
  }
  return result;
}

Napi::Object InitAddon(Napi::Env env, Napi::Object exports) {
  whisper_log_set(WhisperLogFilter, nullptr);
  return WhisperRuntimeWrap::Init(env, exports);
}

NODE_API_MODULE(native_whisper_addon, InitAddon)