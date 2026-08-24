import { mkdirSync as defaultMkdirSync, writeFileSync as defaultWriteFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { encodePcmMessage } from "@voice/streaming-protocol";

const SUBPROTOCOL = "voice-transcription.v1";
const DEFAULT_ORIGIN = "http://localhost:5173";
const DEFAULT_PORT = 8787;
const FRAME_DURATION_MS = 20;
const SAMPLE_RATE_HZ = 16_000;
const SAMPLES_PER_FRAME = 320;
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RESULTS_DIR = join(PACKAGE_ROOT, "..", "benchmark-results");

export const LATENCY_GATES = {
  firstPartialP95Ms: 1500,
  refreshP95Ms: 1000,
  finalAfterSilenceP95Ms: 1500,
};

export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

export function evaluateGates(metrics) {
  return (
    Number.isFinite(metrics.firstPartialP95Ms) &&
    metrics.firstPartialP95Ms <= LATENCY_GATES.firstPartialP95Ms &&
    Number.isFinite(metrics.refreshP95Ms) &&
    metrics.refreshP95Ms <= LATENCY_GATES.refreshP95Ms &&
    Number.isFinite(metrics.finalAfterSilenceP95Ms) &&
    metrics.finalAfterSilenceP95Ms <= LATENCY_GATES.finalAfterSilenceP95Ms
  );
}

export function parseBenchmarkModel(argv) {
  const args = argv ?? process.argv.slice(2);
  const flag = args.indexOf("--model");
  const value = flag === -1 ? "small" : args[flag + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--model requires a name");
  }
  if (value.includes(".en")) {
    throw new Error(`refusing English-only model "${value}": .en weights are not supported`);
  }
  return value;
}

function speechSamples() {
  const samples = new Int16Array(SAMPLES_PER_FRAME);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE_HZ));
  }
  return samples;
}

function silenceSamples() {
  return new Int16Array(SAMPLES_PER_FRAME);
}

function asText(data) {
  if (typeof data === "string") return data;
  return Buffer.from(data).toString();
}

function waitForOpen(socket) {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error) => reject(error));
  });
}

function attachReceiver(socket, now) {
  const firstPartials = [];
  const refreshIntervals = [];
  const finalsAfterSilence = [];
  let lastPartialAt;
  let audioStartedAt;
  let silenceStartedAt;
  const pending = new Set();

  function notify(message) {
    for (const waiter of [...pending]) {
      if (waiter.predicate(message)) {
        pending.delete(waiter);
        waiter.resolve(message);
      }
    }
  }

  function onSegment(event, receivedAt) {
    const segment = event.segment;
    if (!segment || typeof segment !== "object") return;
    if (segment.isFinal === true) {
      if (silenceStartedAt !== undefined) {
        finalsAfterSilence.push(receivedAt - silenceStartedAt);
      }
      return;
    }
    if (segment.isFinal === false) {
      if (audioStartedAt !== undefined && firstPartials.length === 0) {
        firstPartials.push(receivedAt - audioStartedAt);
      }
      if (lastPartialAt !== undefined) {
        refreshIntervals.push(receivedAt - lastPartialAt);
      }
      lastPartialAt = receivedAt;
    }
  }

  socket.on("message", (data, isBinary) => {
    if (isBinary === true) return;
    let message;
    try {
      message = JSON.parse(asText(data));
    } catch {
      return;
    }
    if (message?.type === "engine.event" && message.event?.type === "segment.upsert") {
      onSegment(message.event, now());
    }
    notify(message);
  });

  return {
    markAudioStart(at) {
      audioStartedAt ??= at;
    },
    markSilenceStart(at) {
      silenceStartedAt ??= at;
    },
    waitFor(predicate, label, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const wrapped = {
          predicate,
          resolve(message) {
            clearTimeout(timer);
            resolve(message);
          },
          reject,
        };
        const timer = setTimeout(() => {
          pending.delete(wrapped);
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs);
        pending.add(wrapped);
      });
    },
    metrics() {
      return {
        firstPartials,
        refreshIntervals,
        finalsAfterSilence,
      };
    },
  };
}

async function defaultCreateWebSocket(url, protocols, options) {
  const { default: WebSocket } = await import("ws");
  return new WebSocket(url, protocols, options);
}

export async function runLocalBenchmark(options = {}) {
  const model = options.model ?? parseBenchmarkModel(options.argv ?? process.argv.slice(2));
  const port = options.port ?? Number(process.env.VOICE_PORT ?? DEFAULT_PORT);
  const origin = options.origin ?? process.env.VOICE_ORIGIN ?? DEFAULT_ORIGIN;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const speechFrames = options.speechFrames ?? 150;
  const silenceFrames = options.silenceFrames ?? 50;
  const resultsDir = options.resultsDir ?? DEFAULT_RESULTS_DIR;
  const mkdirSync = options.mkdirSync ?? defaultMkdirSync;
  const writeFileSync = options.writeFileSync ?? defaultWriteFileSync;
  const log = options.log ?? ((line) => console.log(line));
  const createWebSocket = options.createWebSocket ?? defaultCreateWebSocket;
  const sessionId = options.sessionId ?? "benchmark-1";

  const url = `ws://127.0.0.1:${port}`;
  let socket;
  try {
    socket = await createWebSocket(url, SUBPROTOCOL, { origin });
    const receiver = attachReceiver(socket, now);
    await waitForOpen(socket);
    socket.send(
      JSON.stringify({
        type: "session.start",
        protocol: 1,
        request: {
          sessionId,
          candidateLanguages: ["en-US", "vi-VN", "es-ES", "zh-CN"],
          mode: "transcribe",
          audio: {
            encoding: "pcm_s16le",
            sampleRateHz: SAMPLE_RATE_HZ,
            channels: 1,
            frameDurationMs: FRAME_DURATION_MS,
          },
        },
      }),
    );

    const accepted = await receiver.waitFor(
      (message) => message?.type === "session.accepted",
      "session.accepted",
    );
    const backend = accepted.backend ?? "cpu";
    const wallStartedAt = now();
    const voiced = speechSamples();
    const silent = silenceSamples();
    let sequence = 0;

    async function sendFrame(samples) {
      const startMs = sequence * FRAME_DURATION_MS;
      const payload = encodePcmMessage({ sequence, startMs, samples });
      if (sequence === 0) receiver.markAudioStart(now());
      socket.send(payload);
      const expected = sequence;
      await receiver.waitFor(
        (message) => message?.type === "audio.ack" && message.throughSequence === expected,
        "audio.ack",
      );
      sequence += 1;
      await sleep(FRAME_DURATION_MS);
    }

    for (let i = 0; i < speechFrames; i += 1) {
      await sendFrame(voiced);
    }
    receiver.markSilenceStart(now());
    for (let i = 0; i < silenceFrames; i += 1) {
      await sendFrame(silent);
    }

    socket.send(JSON.stringify({ type: "session.stop", sessionId }));

    const samples = receiver.metrics();
    if (samples.finalsAfterSilence.length === 0) {
      await receiver.waitFor(
        (message) =>
          message?.type === "engine.event" &&
          message.event?.type === "segment.upsert" &&
          message.event.segment?.isFinal === true,
        "final segment",
      );
    }

    const audioMs = sequence * FRAME_DURATION_MS;
    const wallMs = Math.max(1, now() - wallStartedAt);
    const metrics = {
      firstPartialP95Ms: samples.firstPartials.length === 0 ? Number.POSITIVE_INFINITY : percentile(samples.firstPartials, 95),
      refreshP95Ms: samples.refreshIntervals.length === 0 ? Number.POSITIVE_INFINITY : percentile(samples.refreshIntervals, 95),
      finalAfterSilenceP95Ms:
        samples.finalsAfterSilence.length === 0 ? Number.POSITIVE_INFINITY : percentile(samples.finalsAfterSilence, 95),
      realTimeFactor: wallMs / audioMs,
      sessions: 1,
      model,
      backend,
      loadCount: 1,
    };
    const passed = evaluateGates(metrics);
    const line = JSON.stringify(metrics);
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, `benchmark-${Date.now()}.json`), `${line}\n`);
    log(line);
    return { ...metrics, passed };
  } finally {
    socket?.close?.();
  }
}

function isCli() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isCli()) {
  runLocalBenchmark()
    .then((result) => {
      process.exit(result.passed ? 0 : 1);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    });
}
