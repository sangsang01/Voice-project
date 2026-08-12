#!/usr/bin/env node
/**
 * Four-session deployment benchmark against a running transcription server.
 *
 * Emits one JSON metrics line to stdout and exits nonzero when latency/RTF
 * gates fail. Optional --baseline compares quantized vs unquantized accuracy.
 *
 * Usage:
 *   node scripts/benchmark.mjs [--url ws://127.0.0.1:8787] [--model small]
 *   node scripts/benchmark.mjs --compare baseline.json candidate.json
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import WebSocket from "ws";
import { encodePcmMessage, parseJsonMessage, validateServerMessage } from "@voice/streaming-protocol";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(
  readFileSync(join(packageRoot, "test", "fixtures", "manifest.json"), "utf8"),
);

const PROTOCOL = "voice-transcription.v1";
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = 320;
const DEFAULT_ORIGIN = process.env.VOICE_BENCHMARK_ORIGIN ?? "http://localhost:5173";
const DEFAULT_TOKEN = process.env.VOICE_AUTH_TOKEN ?? "benchmark-token";

function parseArgs(argv) {
  const args = {
    url: process.env.VOICE_BENCHMARK_URL ?? "ws://127.0.0.1:8787",
    model: process.env.VOICE_BENCHMARK_MODEL ?? "small",
    origin: DEFAULT_ORIGIN,
    token: DEFAULT_TOKEN,
    outDir: join(packageRoot, "benchmark-results"),
    metricsPath: process.env.VOICE_METRICS_PATH ?? null,
    compare: null,
    save: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") args.url = argv[++i];
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--origin") args.origin = argv[++i];
    else if (arg === "--token") args.token = argv[++i];
    else if (arg === "--out-dir") args.outDir = argv[++i];
    else if (arg === "--metrics") args.metricsPath = argv[++i];
    else if (arg === "--no-save") args.save = false;
    else if (arg === "--compare") {
      args.compare = [argv[++i], argv[++i]];
    }
  }
  return args;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return Number.POSITIVE_INFINITY;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function normalizeWords(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeChars(text) {
  return [...text.replace(/\s+/g, "")];
}

function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function errorRate(reference, hypothesis, mode) {
  const ref = mode === "wer" ? normalizeWords(reference) : normalizeChars(reference);
  const hyp = mode === "wer" ? normalizeWords(hypothesis) : normalizeChars(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 100;
  return (editDistance(ref, hyp) / ref.length) * 100;
}

/** Deterministic labeled PCM: speech-like energy followed by trailing silence. */
function synthesizeLabeledPcm(label, speechMs = 2_000, silenceMs = 700) {
  const totalFrames = Math.ceil((speechMs + silenceMs) / FRAME_MS);
  const speechFrames = Math.ceil(speechMs / FRAME_MS);
  const seed = createHash("sha256").update(label).digest();
  const frames = [];

  for (let sequence = 0; sequence < totalFrames; sequence += 1) {
    const samples = new Int16Array(SAMPLES_PER_FRAME);
    if (sequence < speechFrames) {
      const freq = 220 + (seed[sequence % seed.length] % 180);
      for (let i = 0; i < SAMPLES_PER_FRAME; i += 1) {
        const t = (sequence * SAMPLES_PER_FRAME + i) / 16_000;
        const envelope = 0.35 + 0.15 * Math.sin(2 * Math.PI * 3 * t);
        samples[i] = Math.max(
          -32767,
          Math.min(32767, Math.floor(envelope * 12_000 * Math.sin(2 * Math.PI * freq * t))),
        );
      }
    }
    frames.push({ sequence, startMs: sequence * FRAME_MS, samples });
  }
  return frames;
}

function loadSessionAudio(session) {
  const jfkPath = join(packageRoot, "..", "web", "tests", "fixtures", "jfk.wav");
  if (session.language === "en-US" && existsSync(jfkPath)) {
    return wavToFrames(readFileSync(jfkPath), 700);
  }
  return synthesizeLabeledPcm(session.pcmFixture ?? session.id);
}

function wavToFrames(buffer, trailingSilenceMs) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("expected WAV fixture");
  }
  let offset = 12;
  let pcm;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (id === "data") {
      const sampleCount = Math.floor(size / 2);
      pcm = new Int16Array(sampleCount);
      for (let i = 0; i < sampleCount; i += 1) {
        pcm[i] = buffer.readInt16LE(dataStart + i * 2);
      }
      break;
    }
    offset = dataStart + size + (size % 2);
  }
  if (!pcm) throw new Error("WAV missing data chunk");

  const frames = [];
  let sequence = 0;
  for (let i = 0; i + SAMPLES_PER_FRAME <= pcm.length; i += SAMPLES_PER_FRAME) {
    frames.push({
      sequence,
      startMs: sequence * FRAME_MS,
      samples: pcm.subarray(i, i + SAMPLES_PER_FRAME),
    });
    sequence += 1;
  }
  const silenceFrames = Math.ceil(trailingSilenceMs / FRAME_MS);
  for (let i = 0; i < silenceFrames; i += 1) {
    frames.push({
      sequence,
      startMs: sequence * FRAME_MS,
      samples: new Int16Array(SAMPLES_PER_FRAME),
    });
    sequence += 1;
  }
  return frames;
}

function connect(url, { origin, token }) {
  const target = new URL(url);
  if (token) target.searchParams.set("access_token", token);
  return new WebSocket(target, PROTOCOL, { origin });
}

function waitOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function runSession(socket, sessionSpec, audioFrames) {
  const sessionId = `${sessionSpec.id}-${randomUUID()}`;
  const metrics = {
    language: sessionSpec.language,
    referenceText: sessionSpec.referenceText,
    firstPartialMs: null,
    refreshIntervalsMs: [],
    finalAfterSilenceMs: null,
    audioDurationMs: audioFrames.length * FRAME_MS,
    decodeDurationsMs: [],
    finalText: "",
    transcriptStartedAt: null,
    silenceStartedAt: null,
  };

  let lastPartialAt = null;
  let lastPartialText = "";
  let accepted = false;
  let stopped = false;

  const messageQueue = [];
  let waiter = null;
  socket.on("message", (data) => {
    const text = typeof data === "string" ? data : data.toString("utf8");
    const message = validateServerMessage(parseJsonMessage(text));
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(message);
    } else {
      messageQueue.push(message);
    }
  });

  const nextMessage = () =>
    messageQueue.length > 0
      ? Promise.resolve(messageQueue.shift())
      : new Promise((resolve) => {
          waiter = resolve;
        });

  const pump = (async () => {
    while (!stopped) {
      const message = await nextMessage();
      if (message.type === "session.accepted") {
        accepted = true;
        continue;
      }
      if (message.type !== "engine.event") continue;
      const event = message.event;
      const now = performance.now();

      if (event.type === "segment.upsert") {
        if (!event.segment.isFinal) {
          if (metrics.firstPartialMs === null && metrics.transcriptStartedAt !== null) {
            metrics.firstPartialMs = now - metrics.transcriptStartedAt;
          }
          if (lastPartialAt !== null && event.segment.text !== lastPartialText) {
            metrics.refreshIntervalsMs.push(now - lastPartialAt);
          }
          lastPartialAt = now;
          lastPartialText = event.segment.text;
        } else {
          metrics.finalText = event.segment.text;
          if (metrics.silenceStartedAt !== null && metrics.finalAfterSilenceMs === null) {
            metrics.finalAfterSilenceMs = now - metrics.silenceStartedAt;
          }
        }
      }

      if (event.type === "state" && event.state === "stopped") {
        stopped = true;
      }
      if (event.type === "error" && event.fatal) {
        throw new Error(`${event.code}: ${event.message}`);
      }
    }
  })();

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
          sampleRateHz: 16000,
          channels: 1,
          frameDurationMs: 20,
        },
      },
    }),
  );

  const deadline = Date.now() + 15_000;
  while (!accepted && Date.now() < deadline) {
    await delay(10);
  }
  if (!accepted) throw new Error(`session ${sessionId} was not accepted`);

  metrics.transcriptStartedAt = performance.now();
  const speechEndIndex = audioFrames.findIndex(
    (frame, index) => index > 0 && frame.samples.every((s) => s === 0),
  );

  for (let i = 0; i < audioFrames.length; i += 1) {
    const frame = audioFrames[i];
    if (speechEndIndex >= 0 && i === speechEndIndex && metrics.silenceStartedAt === null) {
      metrics.silenceStartedAt = performance.now();
    }
    socket.send(encodePcmMessage(frame));
    await delay(FRAME_MS);
  }
  if (metrics.silenceStartedAt === null) {
    metrics.silenceStartedAt = performance.now();
  }

  socket.send(JSON.stringify({ type: "session.stop", sessionId }));
  const stopDeadline = Date.now() + 30_000;
  while (!stopped && Date.now() < stopDeadline) {
    await delay(20);
  }
  if (!stopped) throw new Error(`session ${sessionId} did not stop`);
  await pump.catch(() => undefined);
  return metrics;
}

export function evaluateGates(report, gates = manifest.gates) {
  const failures = [];
  if (!Number.isFinite(report.firstPartialP95Ms) || !(report.firstPartialP95Ms <= gates.firstPartialP95Ms)) {
    failures.push(`firstPartialP95Ms ${report.firstPartialP95Ms} > ${gates.firstPartialP95Ms}`);
  }
  if (!Number.isFinite(report.refreshP95Ms) || !(report.refreshP95Ms <= gates.refreshP95Ms)) {
    failures.push(`refreshP95Ms ${report.refreshP95Ms} > ${gates.refreshP95Ms}`);
  }
  if (
    !Number.isFinite(report.finalAfterSilenceP95Ms) ||
    !(report.finalAfterSilenceP95Ms <= gates.finalAfterSilenceP95Ms)
  ) {
    failures.push(
      `finalAfterSilenceP95Ms ${report.finalAfterSilenceP95Ms} > ${gates.finalAfterSilenceP95Ms}`,
    );
  }
  if (!Number.isFinite(report.realTimeFactor) || !(report.realTimeFactor < gates.realTimeFactor)) {
    failures.push(`realTimeFactor ${report.realTimeFactor} >= ${gates.realTimeFactor}`);
  }
  return failures;
}

export function compareAccuracy(baseline, candidate, limits = manifest.accuracyRegression) {
  const failures = [];
  const languages = new Set([
    ...Object.keys(baseline.werByLanguage ?? {}),
    ...Object.keys(candidate.werByLanguage ?? {}),
    ...Object.keys(baseline.cerByLanguage ?? {}),
    ...Object.keys(candidate.cerByLanguage ?? {}),
  ]);

  let baseWerSum = 0;
  let candWerSum = 0;
  let baseCerSum = 0;
  let candCerSum = 0;
  let werCount = 0;
  let cerCount = 0;

  for (const language of languages) {
    const baseWer = baseline.werByLanguage?.[language];
    const candWer = candidate.werByLanguage?.[language];
    if (typeof baseWer === "number" && typeof candWer === "number") {
      werCount += 1;
      baseWerSum += baseWer;
      candWerSum += candWer;
      if (candWer - baseWer > limits.perLanguageAbsolutePoints) {
        failures.push(`WER regression for ${language}: ${candWer - baseWer} points`);
      }
    }

    const baseCer = baseline.cerByLanguage?.[language];
    const candCer = candidate.cerByLanguage?.[language];
    if (typeof baseCer === "number" && typeof candCer === "number") {
      cerCount += 1;
      baseCerSum += baseCer;
      candCerSum += candCer;
      if (candCer - baseCer > limits.perLanguageAbsolutePoints) {
        failures.push(`CER regression for ${language}: ${candCer - baseCer} points`);
      }
    }
  }

  if (werCount > 0 && candWerSum / werCount - baseWerSum / werCount > limits.aggregateAbsolutePoints) {
    failures.push("aggregate WER regression above one absolute point");
  }
  if (cerCount > 0 && candCerSum / cerCount - baseCerSum / cerCount > limits.aggregateAbsolutePoints) {
    failures.push("aggregate CER regression above one absolute point");
  }

  return failures;
}

function readDecodeMetrics(metricsPath) {
  if (!metricsPath || !existsSync(metricsPath)) return [];
  return readFileSync(metricsPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => typeof row.decodeDurationMs === "number" && typeof row.audioDurationMs === "number");
}

/** Decoder RTF = total decode compute time / total audio duration (not paced wall clock). */
export function computeRealTimeFactor(decodeMetrics) {
  if (!Array.isArray(decodeMetrics) || decodeMetrics.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const decodeMs = decodeMetrics.reduce((sum, row) => sum + row.decodeDurationMs, 0);
  const audioMs = decodeMetrics.reduce((sum, row) => sum + row.audioDurationMs, 0);
  if (!(audioMs > 0)) return Number.POSITIVE_INFINITY;
  return Number((decodeMs / audioMs).toFixed(4));
}

function buildReport(model, sessionMetrics, decodeMetrics = []) {
  const firstPartials = sessionMetrics
    .map((s) => s.firstPartialMs)
    .filter((v) => typeof v === "number")
    .sort((a, b) => a - b);
  const refreshes = sessionMetrics
    .flatMap((s) => s.refreshIntervalsMs)
    .sort((a, b) => a - b);
  const finals = sessionMetrics
    .map((s) => s.finalAfterSilenceMs)
    .filter((v) => typeof v === "number")
    .sort((a, b) => a - b);

  const werByLanguage = {};
  const cerByLanguage = {};
  for (const session of sessionMetrics) {
    const mode = session.language.startsWith("zh") ? "cer" : "wer";
    const rate = errorRate(session.referenceText, session.finalText || "", mode);
    if (mode === "wer") werByLanguage[session.language] = Number(rate.toFixed(2));
    else cerByLanguage[session.language] = Number(rate.toFixed(2));
  }

  return {
    firstPartialP95Ms: Number(percentile(firstPartials, 95).toFixed(2)),
    refreshP95Ms: Number(percentile(refreshes, 95).toFixed(2)),
    finalAfterSilenceP95Ms: Number(percentile(finals, 95).toFixed(2)),
    realTimeFactor: computeRealTimeFactor(decodeMetrics),
    sessions: sessionMetrics.length,
    model,
    werByLanguage,
    cerByLanguage,
  };
}

async function runBenchmark(args) {
  const sessions = manifest.benchmarkSessions;
  if (!Array.isArray(sessions) || sessions.length !== 4) {
    throw new Error("manifest must define exactly four benchmarkSessions");
  }

  const sockets = sessions.map(() => connect(args.url, args));
  await Promise.all(sockets.map(waitOpen));

  const results = await Promise.all(
    sessions.map((spec, index) => runSession(sockets[index], spec, loadSessionAudio(spec))),
  );
  const decodeMetrics = readDecodeMetrics(args.metricsPath);
  const report = buildReport(args.model, results, decodeMetrics);

  for (const socket of sockets) {
    try {
      socket.close();
    } catch {
      // ignore
    }
  }
  return report;
}

function selectModelNote(smallReport, mediumReport) {
  const smallFails = evaluateGates(smallReport);
  const mediumFails = evaluateGates(mediumReport);
  if (mediumFails.length === 0) {
    return {
      selected: "medium",
      reason: "medium passed every latency gate; preferred for accuracy",
    };
  }
  if (smallFails.length === 0) {
    return {
      selected: "small",
      reason: "medium missed latency gates; small is the fastest passing tier",
    };
  }
  return {
    selected: null,
    reason: "neither tier passed every latency gate",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.compare) {
    const [baselinePath, candidatePath] = args.compare;
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
    const gateFailures = evaluateGates(candidate);
    const accuracyFailures = compareAccuracy(baseline, candidate);
    const report = { ...candidate, gateFailures, accuracyFailures };
    console.log(JSON.stringify(report));
    if (gateFailures.length > 0 || accuracyFailures.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  const report = await runBenchmark(args);
  const failures = evaluateGates(report);
  console.log(JSON.stringify(report));

  if (args.save) {
    mkdirSync(args.outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = join(args.outDir, `${stamp}-${args.model}.json`);
    writeFileSync(outPath, `${JSON.stringify(report)}\n`);
    console.error(`wrote ${outPath}`);
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`gate failed: ${failure}`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && /benchmark\.mjs$/.test(entry)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { selectModelNote, buildReport };
