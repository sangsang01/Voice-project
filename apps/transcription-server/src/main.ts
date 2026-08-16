import { loadNativeWhisperAddon } from "@voice/native-whisper-addon";
import { assertLoopbackBindHost } from "@voice/streaming-protocol";

import { FakeRuntime } from "./fakeRuntime.js";
import { createTranscriptionGateway } from "./gateway.js";
import { createNativeStreamingRuntime, type NativeStreamingRuntime } from "./nativeRuntime.js";
import type { StreamingRuntime } from "./runtime.js";

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

function parsePort(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? String(fallback));
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
  return parsed;
}

function parseConfig() {
  const host = process.env.VOICE_HOST ?? "127.0.0.1";
  const port = parsePort(process.env.VOICE_PORT, 8787, "VOICE_PORT");
  const allowedOrigins = (process.env.VOICE_ALLOWED_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const capacity = parsePort(process.env.VOICE_MAX_SESSIONS, 1, "VOICE_MAX_SESSIONS");
  if (capacity < 1) {
    throw new Error("VOICE_MAX_SESSIONS must be a positive integer");
  }
  const fake = process.env.VOICE_FAKE_RUNTIME === "1";
  const modelPath = process.env.VOICE_MODEL_PATH;
  const vadModelPath = process.env.VOICE_VAD_MODEL_PATH;
  const useGpu = process.env.VOICE_USE_GPU === "1";
  const threads = parsePort(process.env.VOICE_THREADS, 4, "VOICE_THREADS");
  if (!fake) {
    if (!modelPath || !vadModelPath) {
      throw new Error("VOICE_MODEL_PATH and VOICE_VAD_MODEL_PATH are required");
    }
  }
  assertLoopbackBindHost(host);
  return { host, port, allowedOrigins, capacity, fake, modelPath, vadModelPath, useGpu, threads };
}

async function main(): Promise<void> {
  const config = parseConfig();
  let native: NativeStreamingRuntime | undefined;
  let runtime: StreamingRuntime;
  if (config.fake) {
    runtime = new FakeRuntime();
  } else {
    native = createNativeStreamingRuntime({
      modelPath: config.modelPath!,
      vadModelPath: config.vadModelPath!,
      threads: config.threads,
      useGpu: config.useGpu,
      loadAddon: () => loadNativeWhisperAddon(),
    });
    await native.ready();
    runtime = native;
  }

  const gateway = await createTranscriptionGateway({
    host: config.host,
    port: config.port,
    runtime,
    capacity: config.capacity,
    allowedOrigins: config.allowedOrigins,
  });
  console.error(`listening on ws://${config.host}:${gateway.port}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await gateway.close();
      await native?.close();
    } finally {
      process.exit(0);
    }
  };
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      void shutdown();
    });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
