# @voice/native-whisper-addon

Persistent N-API whisper.cpp + Silero VAD runtime used by
`@voice/transcription-server`. The TypeScript package is a loader and type
surface; the `.node` binary is an explicit opt-in native build.

Do not patch `vendor/whisper.cpp`. All C++ glue for this path lives under
`native/` in this package.

## TypeScript loader

```ts
import { loadNativeWhisperAddon } from "@voice/native-whisper-addon";

const addon = loadNativeWhisperAddon();
const handle = addon.createRuntime({
  modelPath,
  vadModelPath,
  threads: 4,
  useGpu: true,
});
```

`loadNativeWhisperAddon()` resolves
`build/Release/native-whisper-addon.node` by default. If the binary is missing,
it throws with instructions to run `build:native`. Tests inject `loadBinary` /
`binaryPath` so ordinary CI never requires CMake or a GPU.

## Native lifecycle invariants

- **Model-handle serialization.** Each `NativeRuntimeHandle` runs at most one
  `decode()` at a time. The server pool leases one handle per session and the
  session adapter chains/races decodes so overlapping provisional ticks cannot
  enter the same handle concurrently.
- **Warm handles.** `warmup()` runs before a handle enters the idle pool.
  Unhealthy/timed-out handles are closed and replaced before the slot is
  readmitted.
- **Stateful VAD.** `pushVad(samples)` preserves Silero recurrent state across
  the continuous microphone stream; `reset()` clears it between leases.
- **Multilingual models only.** Callers must reject English-only `.en` weight
  names before `createRuntime`.

## Build commands

TypeScript loader (part of root `npm run build`):

```bash
npm run build --workspace @voice/native-whisper-addon
```

Native binary (explicit; not `postinstall`, not ordinary CI):

```bash
npm run build:native --workspace @voice/native-whisper-addon
```

`build:native` runs `cmake-js compile -T native-whisper-addon -B Release`.
Requires a local C++ toolchain and, for GPU builds, CUDA-capable whisper.cpp
configuration as documented by the transcription-server CUDA image.

## Fake-runtime test path

Server and addon unit tests inject fake `NativeRuntimeHandle` / `NativeAddon`
implementations (or a fake `loadBinary`) so `npm test` never loads a real
`.node` module. Real GPU/native verification is
`npm run test:native --workspace @voice/transcription-server` after
`build:native` and model provisioning.
