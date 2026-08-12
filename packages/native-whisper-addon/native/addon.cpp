#include <napi.h>

#include "whisper.h"

#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

namespace {

constexpr int kSampleRate = WHISPER_SAMPLE_RATE;
constexpr int kVadWindowSamples = 512;
constexpr int kWarmupSamples = kSampleRate; // 1s of silence

float int16ToFloat(int16_t sample) {
  return sample / 32768.0f;
}

void appendInt16AsFloat(const int16_t * input, size_t count, std::vector<float> & out) {
  const size_t offset = out.size();
  out.resize(offset + count);
  for (size_t i = 0; i < count; ++i) {
    out[offset + i] = int16ToFloat(input[i]);
  }
}

struct DecodeResult {
  std::string text;
  std::string language = "und";
  int32_t startMs = 0;
  int32_t endMs = 0;
};

DecodeResult runFull(
    whisper_context * ctx,
    const std::vector<float> & samples,
    const std::string & prompt,
    int threads) {
  DecodeResult result;
  if (ctx == nullptr || samples.empty()) {
    return result;
  }

  whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  params.n_threads = threads;
  params.translate = false;
  params.language = nullptr;
  params.detect_language = false;
  params.print_progress = false;
  params.print_realtime = false;
  params.print_timestamps = false;
  params.no_timestamps = true;
  params.single_segment = false;
  params.no_context = prompt.empty();
  params.vad = false;
  params.initial_prompt = prompt.empty() ? nullptr : prompt.c_str();

  if (whisper_full(ctx, params, samples.data(), static_cast<int>(samples.size())) != 0) {
    return result;
  }

  const int n = whisper_full_n_segments(ctx);
  for (int i = 0; i < n; ++i) {
    const char * text = whisper_full_get_segment_text(ctx, i);
    if (text != nullptr) {
      result.text += text;
    }
  }

  const int langId = whisper_full_lang_id(ctx);
  if (langId >= 0) {
    const char * lang = whisper_lang_str(langId);
    if (lang != nullptr) {
      result.language = lang;
    }
  }

  if (n > 0) {
    // Segment times are in centiseconds even when timestamp tokens are disabled.
    result.startMs = static_cast<int32_t>(whisper_full_get_segment_t0(ctx, 0) * 10);
    result.endMs = static_cast<int32_t>(whisper_full_get_segment_t1(ctx, n - 1) * 10);
  } else {
    result.endMs = static_cast<int32_t>((samples.size() * 1000) / kSampleRate);
  }

  return result;
}

class WhisperRuntimeWrap : public Napi::ObjectWrap<WhisperRuntimeWrap> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(
        env,
        "WhisperRuntime",
        {
            InstanceMethod("pushVad", &WhisperRuntimeWrap::PushVad),
            InstanceMethod("decode", &WhisperRuntimeWrap::Decode),
            InstanceMethod("warmup", &WhisperRuntimeWrap::Warmup),
            InstanceMethod("reset", &WhisperRuntimeWrap::Reset),
            InstanceMethod("close", &WhisperRuntimeWrap::Close),
        });

    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();

    exports.Set(
        "createRuntime",
        Napi::Function::New(env, [](const Napi::CallbackInfo & info) {
          return constructor.New({info[0]});
        }));
    return exports;
  }

  explicit WhisperRuntimeWrap(const Napi::CallbackInfo & info)
      : Napi::ObjectWrap<WhisperRuntimeWrap>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
      Napi::TypeError::New(env, "createRuntime expects an options object").ThrowAsJavaScriptException();
      return;
    }

    Napi::Object options = info[0].As<Napi::Object>();
    const std::string modelPath = options.Get("modelPath").ToString().Utf8Value();
    const std::string vadModelPath = options.Get("vadModelPath").ToString().Utf8Value();
    threads_ = options.Has("threads") ? options.Get("threads").ToNumber().Int32Value() : 1;
    if (threads_ < 1) {
      threads_ = 1;
    }
    const bool useGpu = options.Has("useGpu") && options.Get("useGpu").ToBoolean().Value();

    whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu = useGpu;
    ctx_ = whisper_init_from_file_with_params(modelPath.c_str(), cparams);
    if (ctx_ == nullptr) {
      Napi::Error::New(env, "Failed to load whisper model: " + modelPath).ThrowAsJavaScriptException();
      return;
    }

    whisper_vad_context_params vparams = whisper_vad_default_context_params();
    vparams.n_threads = threads_;
    vparams.use_gpu = useGpu;
    vctx_ = whisper_vad_init_from_file_with_params(vadModelPath.c_str(), vparams);
    if (vctx_ == nullptr) {
      whisper_free(ctx_);
      ctx_ = nullptr;
      Napi::Error::New(env, "Failed to load VAD model: " + vadModelPath).ThrowAsJavaScriptException();
      return;
    }

    floatBuffer_.reserve(kVadWindowSamples * 4);
    carry_.reserve(kVadWindowSamples);
  }

  ~WhisperRuntimeWrap() override { CloseInternal(); }

private:
  static Napi::FunctionReference constructor;

  class DecodeWorker : public Napi::AsyncWorker {
  public:
    DecodeWorker(
        Napi::Env env,
        WhisperRuntimeWrap * runtime,
        std::vector<int16_t> samples,
        std::string prompt)
        : Napi::AsyncWorker(env),
          deferred_(Napi::Promise::Deferred::New(env)),
          runtime_(runtime),
          samples_(std::move(samples)),
          prompt_(std::move(prompt)) {
      runtime_->Ref();
    }

    ~DecodeWorker() override { runtime_->Unref(); }

    Napi::Promise Promise() { return deferred_.Promise(); }

    void Execute() override {
      std::vector<float> pcm;
      pcm.reserve(samples_.size());
      for (int16_t sample : samples_) {
        pcm.push_back(int16ToFloat(sample));
      }

      std::lock_guard<std::mutex> lock(runtime_->mutex_);
      if (runtime_->closed_ || runtime_->ctx_ == nullptr) {
        SetError("Native whisper runtime is closed");
        return;
      }
      result_ = runFull(runtime_->ctx_, pcm, prompt_, runtime_->threads_);
    }

    void OnOK() override {
      Napi::Env env = Env();
      Napi::Object obj = Napi::Object::New(env);
      obj.Set("text", Napi::String::New(env, result_.text));
      obj.Set("language", Napi::String::New(env, result_.language));
      obj.Set("startMs", Napi::Number::New(env, result_.startMs));
      obj.Set("endMs", Napi::Number::New(env, result_.endMs));
      deferred_.Resolve(obj);
    }

    void OnError(const Napi::Error & error) override { deferred_.Reject(error.Value()); }

  private:
    Napi::Promise::Deferred deferred_;
    WhisperRuntimeWrap * runtime_;
    std::vector<int16_t> samples_;
    std::string prompt_;
    DecodeResult result_;
  };

  class WarmupWorker : public Napi::AsyncWorker {
  public:
    WarmupWorker(Napi::Env env, WhisperRuntimeWrap * runtime)
        : Napi::AsyncWorker(env),
          deferred_(Napi::Promise::Deferred::New(env)),
          runtime_(runtime) {
      runtime_->Ref();
    }

    ~WarmupWorker() override { runtime_->Unref(); }

    Napi::Promise Promise() { return deferred_.Promise(); }

    void Execute() override {
      std::vector<float> silence(kWarmupSamples, 0.0f);
      std::lock_guard<std::mutex> lock(runtime_->mutex_);
      if (runtime_->closed_ || runtime_->ctx_ == nullptr) {
        SetError("Native whisper runtime is closed");
        return;
      }
      (void)runFull(runtime_->ctx_, silence, "", runtime_->threads_);
    }

    void OnOK() override { deferred_.Resolve(Env().Undefined()); }

    void OnError(const Napi::Error & error) override { deferred_.Reject(error.Value()); }

  private:
    Napi::Promise::Deferred deferred_;
    WhisperRuntimeWrap * runtime_;
  };

  Napi::Value PushVad(const Napi::CallbackInfo & info) {
    Napi::Env env = info.Env();
    if (closed_ || vctx_ == nullptr) {
      Napi::Error::New(env, "Native whisper runtime is closed").ThrowAsJavaScriptException();
      return env.Null();
    }
    if (info.Length() < 1 || !info[0].IsTypedArray()) {
      Napi::TypeError::New(env, "pushVad expects an Int16Array").ThrowAsJavaScriptException();
      return env.Null();
    }

    Napi::Int16Array input = info[0].As<Napi::Int16Array>();
    appendInt16AsFloat(input.Data(), input.ElementLength(), carry_);

    std::vector<float> probs;
    while (carry_.size() >= static_cast<size_t>(kVadWindowSamples)) {
      floatBuffer_.assign(carry_.begin(), carry_.begin() + kVadWindowSamples);
      carry_.erase(carry_.begin(), carry_.begin() + kVadWindowSamples);

      if (!whisper_vad_detect_speech_no_reset(
              vctx_, floatBuffer_.data(), static_cast<int>(floatBuffer_.size()))) {
        continue;
      }

      const int n = whisper_vad_n_probs(vctx_);
      float * values = whisper_vad_probs(vctx_);
      for (int i = 0; i < n; ++i) {
        probs.push_back(values[i]);
      }
    }

    Napi::Float32Array out = Napi::Float32Array::New(env, probs.size());
    if (!probs.empty()) {
      std::memcpy(out.Data(), probs.data(), probs.size() * sizeof(float));
    }
    return out;
  }

  Napi::Value Decode(const Napi::CallbackInfo & info) {
    Napi::Env env = info.Env();
    if (closed_) {
      Napi::Error::New(env, "Native whisper runtime is closed").ThrowAsJavaScriptException();
      return env.Null();
    }
    if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsString()) {
      Napi::TypeError::New(env, "decode expects (Int16Array, string)").ThrowAsJavaScriptException();
      return env.Null();
    }

    Napi::Int16Array input = info[0].As<Napi::Int16Array>();
    // Copy before leaving the JS thread so the TypedArray backing store can move.
    std::vector<int16_t> samples(input.Data(), input.Data() + input.ElementLength());
    std::string prompt = info[1].As<Napi::String>().Utf8Value();

    auto * worker = new DecodeWorker(env, this, std::move(samples), std::move(prompt));
    Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
  }

  Napi::Value Warmup(const Napi::CallbackInfo & info) {
    Napi::Env env = info.Env();
    if (closed_) {
      Napi::Error::New(env, "Native whisper runtime is closed").ThrowAsJavaScriptException();
      return env.Null();
    }

    auto * worker = new WarmupWorker(env, this);
    Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
  }

  Napi::Value Reset(const Napi::CallbackInfo & info) {
    (void)info;
    carry_.clear();
    if (vctx_ != nullptr) {
      whisper_vad_reset_state(vctx_);
    }
    return info.Env().Undefined();
  }

  Napi::Value Close(const Napi::CallbackInfo & info) {
    CloseInternal();
    return info.Env().Undefined();
  }

  void CloseInternal() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (closed_) {
      return;
    }
    closed_ = true;
    if (vctx_ != nullptr) {
      whisper_vad_free(vctx_);
      vctx_ = nullptr;
    }
    if (ctx_ != nullptr) {
      whisper_free(ctx_);
      ctx_ = nullptr;
    }
    carry_.clear();
    floatBuffer_.clear();
  }

  whisper_context * ctx_ = nullptr;
  whisper_vad_context * vctx_ = nullptr;
  std::vector<float> floatBuffer_;
  std::vector<float> carry_;
  std::mutex mutex_;
  int threads_ = 1;
  bool closed_ = false;
};

Napi::FunctionReference WhisperRuntimeWrap::constructor;

} // namespace

Napi::Object InitAddon(Napi::Env env, Napi::Object exports) {
  return WhisperRuntimeWrap::Init(env, exports);
}

NODE_API_MODULE(native_whisper_addon, InitAddon)
