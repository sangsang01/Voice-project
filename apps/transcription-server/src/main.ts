/**
 * Production entrypoint: load the native whisper addon, warm a fixed decoder
 * pool, and serve authenticated WebSocket transcription sessions.
 */
import { createServer, type Server } from "node:http";
import { basename } from "node:path";

import { loadNativeWhisperAddon } from "@voice/native-whisper-addon";

import { createTranscriptionGateway } from "./gateway.js";
import { RuntimePool } from "./runtimePool.js";

export interface ServerEnv {
  modelPath: string;
  vadModelPath: string;
  port: number;
  allowedOrigins: string[];
  maxSessions: number;
  bindHost: string;
  requireAuth: boolean;
}

export function loadServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const modelPath = required(env.VOICE_MODEL_PATH, "VOICE_MODEL_PATH");
  const vadModelPath = required(env.VOICE_VAD_MODEL_PATH, "VOICE_VAD_MODEL_PATH");
  const port = parsePort(required(env.VOICE_PORT, "VOICE_PORT"));
  const maxSessions = parsePositiveInt(required(env.VOICE_MAX_SESSIONS, "VOICE_MAX_SESSIONS"), "VOICE_MAX_SESSIONS");
  const allowedOriginsRaw = required(env.VOICE_ALLOWED_ORIGINS, "VOICE_ALLOWED_ORIGINS");
  const allowedOrigins = allowedOriginsRaw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (allowedOrigins.length === 0) {
    throw new Error("missing required production configuration: VOICE_ALLOWED_ORIGINS");
  }

  const bindHost = (env.VOICE_BIND_HOST ?? "0.0.0.0").trim() || "0.0.0.0";
  const requireAuth = env.VOICE_REQUIRE_AUTH !== "0";
  const loopback = isLoopbackHost(bindHost);

  if (!loopback && !requireAuth) {
    throw new Error("unauthenticated mode is only allowed when bound to loopback");
  }

  assertMultilingualModel(modelPath);

  if (requireAuth) {
    const authToken = env.VOICE_AUTH_TOKEN;
    if (typeof authToken !== "string" || authToken.trim().length === 0) {
      throw new Error("missing required production configuration: VOICE_AUTH_TOKEN");
    }
  }

  return {
    modelPath,
    vadModelPath,
    port,
    allowedOrigins,
    maxSessions,
    bindHost,
    requireAuth,
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadServerEnv(env);
  const addon = loadNativeWhisperAddon();
  const threads = parsePositiveInt(env.VOICE_THREADS ?? "4", "VOICE_THREADS");
  const useGpu = env.VOICE_USE_GPU !== "0";
  // Design default concurrency is four warm decoders; operators size via VOICE_MAX_SESSIONS.
  const capacity = config.maxSessions;

  const pool = await RuntimePool.create({
    modelName: modelNameFromPath(config.modelPath),
    capacity,
    createHandle: () =>
      addon.createRuntime({
        modelPath: config.modelPath,
        vadModelPath: config.vadModelPath,
        threads,
        useGpu,
      }),
  });

  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });

  const closeGateway = createTranscriptionGateway({
    server,
    runtime: pool,
    capacity,
    allowedOrigins: config.allowedOrigins,
    authenticate(token) {
      if (!config.requireAuth) {
        return { accountId: "anonymous" };
      }
      if (typeof token !== "string" || token.length === 0) {
        throw new Error("missing access token");
      }
      const expected = required(env.VOICE_AUTH_TOKEN, "VOICE_AUTH_TOKEN");
      if (token !== expected) {
        throw new Error("invalid access token");
      }
      return { accountId: `account-${token.slice(0, 16)}` };
    },
  });

  await listen(server, config.port, config.bindHost);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`shutting down on ${signal}`);
    try {
      pool.stopAdmission();
      closeGateway();
      await pool.shutdown({ drainTimeoutMs: 10_000 });
      await closeHttpServer(server);
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  console.error(
    `transcription server listening on ${config.bindHost}:${config.port} model=${config.modelPath} capacity=${capacity}`,
  );
}

export function assertMultilingualModel(modelPath: string): void {
  const name = basename(modelPath);
  if (/\.en(?:\.|$)/i.test(name)) {
    throw new Error("VOICE_MODEL_PATH must reference a multilingual model");
  }
}

function modelNameFromPath(modelPath: string): string {
  return basename(modelPath).replace(/^ggml-/, "").replace(/\.bin$/i, "") || "whisper";
}

function required(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`missing required production configuration: ${name}`);
  }
  return value.trim();
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("missing required production configuration: VOICE_PORT");
  }
  return port;
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`missing required production configuration: ${name}`);
  }
  return parsed;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1"
  );
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const entry = process.argv[1];
if (entry && (entry.endsWith("main.js") || entry.endsWith("main.ts"))) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
