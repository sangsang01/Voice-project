# @voice/native-whisper-addon

Node-API wrapper around the pinned `vendor/whisper.cpp` submodule. One process
holds one warm Whisper context and one Silero VAD context. Ordinary
`npm install` and `npm run build` compile only the TypeScript loader; they do
**not** compile the `.node` binary.

## Windows toolchain

`npm run build:native --workspace @voice/native-whisper-addon` needs:

- CMake
- A C++17 compiler: Visual Studio Build Tools (MSVC) or LLVM
- Node.js matching the rest of the repo

The repository path may contain spaces (for example `Tài liệu`). cmake-js
accepts that path; quote it if you invoke CMake by hand.

```powershell
npm run build:native --workspace @voice/native-whisper-addon
```

The binary lands at `build/Release/native-whisper-addon.node`. Do not commit
that file or downloaded model weights.

## CPU default, GPU opt-in

The default CMake configuration is CPU. `useGpu` / `VOICE_USE_GPU=1` is a
runtime flag on a binary that was already compiled with CUDA or Vulkan. Do
not set `VOICE_USE_GPU=1` on the default CPU build.

## Timeout close

`close()` sets the whisper.cpp abort callback, then joins the current ggml
graph (the in-flight `whisper_full`) before freeing contexts. The
transcription server uses that on a decode timeout, then reloads weights
**once** and opens a new handle. That reload is recovery only; there is no
idle unload and no periodic model refresh.

## Native smoke test

`VOICE_MODEL_PATH` and `VOICE_VAD_MODEL_PATH` unset: the smoke test skips.
`VOICE_REQUIRE_NATIVE_TEST=1` without those paths: the smoke test fails.
With both paths set, the test loads once, warms up, and transcribes the JFK
fixture.
