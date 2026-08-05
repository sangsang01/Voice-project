export interface Limits {
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  frameBytes: number;
  maxBufferedAudioMs: number;
  maxConcurrentSessions: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  idleTimeoutMs: 30_000,
  hardTimeoutMs: 10 * 60_000,
  frameBytes: 640,
  maxBufferedAudioMs: 2_000,
  maxConcurrentSessions: 20,
});

/** Documented safe ceilings; startup rejects any configured value above these regardless of environment. */
const CEILINGS: Readonly<Limits> = Object.freeze({
  idleTimeoutMs: 5 * 60_000,
  hardTimeoutMs: 30 * 60_000,
  frameBytes: 640,
  maxBufferedAudioMs: 10_000,
  maxConcurrentSessions: 200,
});

export interface AppConfig {
  limits: Limits;
  allowedOrigins: readonly string[];
  port: number;
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number, ceiling: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  if (value > ceiling) {
    throw new RangeError(`${name} exceeds the maximum safe value of ${ceiling}`);
  }
  return value;
}

/**
 * This gateway performs no user authentication. Do not enable it on a
 * public deployment until the deployer adds authentication in front of it.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isTest = env.NODE_ENV === "test";
  const allowedOriginsRaw = env.ALLOWED_ORIGINS;
  if (!isTest && (!allowedOriginsRaw || allowedOriginsRaw.trim().length === 0)) {
    throw new RangeError("ALLOWED_ORIGINS is required outside test mode");
  }
  const allowedOrigins = (allowedOriginsRaw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const limits: Limits = {
    idleTimeoutMs: parsePositiveInt(
      "IDLE_TIMEOUT_MS",
      env.IDLE_TIMEOUT_MS,
      DEFAULT_LIMITS.idleTimeoutMs,
      CEILINGS.idleTimeoutMs,
    ),
    hardTimeoutMs: parsePositiveInt(
      "HARD_TIMEOUT_MS",
      env.HARD_TIMEOUT_MS,
      DEFAULT_LIMITS.hardTimeoutMs,
      CEILINGS.hardTimeoutMs,
    ),
    frameBytes: DEFAULT_LIMITS.frameBytes,
    maxBufferedAudioMs: parsePositiveInt(
      "MAX_BUFFERED_AUDIO_MS",
      env.MAX_BUFFERED_AUDIO_MS,
      DEFAULT_LIMITS.maxBufferedAudioMs,
      CEILINGS.maxBufferedAudioMs,
    ),
    maxConcurrentSessions: parsePositiveInt(
      "MAX_CONCURRENT_SESSIONS",
      env.MAX_CONCURRENT_SESSIONS,
      DEFAULT_LIMITS.maxConcurrentSessions,
      CEILINGS.maxConcurrentSessions,
    ),
  };

  const port = parsePositiveInt("PORT", env.PORT, 8080, 65_535);

  return { limits, allowedOrigins, port };
}

export function isAllowedOrigin(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}
