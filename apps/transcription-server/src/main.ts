/**
 * Production entrypoint stub for Task 6.
 * Native runtime pooling is wired in a later task; this process still validates
 * required configuration and fails closed when production values are missing.
 */
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
  // Native StreamingRuntime is provided by a later task. Fail explicitly so
  // operators do not start an empty gateway that accepts sockets without models.
  throw new Error(
    `transcription server configuration is valid (model=${config.modelPath}, port=${config.port}), ` +
      "but the native runtime is not wired yet",
  );
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

const entry = process.argv[1];
if (entry && (entry.endsWith("main.js") || entry.endsWith("main.ts"))) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
