import type { Limits } from "../config";

export interface SessionLimitsOptions {
  limits: Limits;
  onIdleTimeout: () => void;
  onHardTimeout: () => void;
}

/**
 * Idle timer resets on every valid session activity; the hard timer is an
 * absolute session-length cap and is never reset once started.
 */
export class SessionLimits {
  private readonly limits: Limits;
  private readonly onIdleTimeout: () => void;
  private readonly onHardTimeout: () => void;
  private idleTimer: NodeJS.Timeout;
  private readonly hardTimer: NodeJS.Timeout;
  private bufferedMs = 0;
  private disposed = false;

  constructor(options: SessionLimitsOptions) {
    this.limits = options.limits;
    this.onIdleTimeout = options.onIdleTimeout;
    this.onHardTimeout = options.onHardTimeout;
    this.idleTimer = setTimeout(() => this.fireIdle(), this.limits.idleTimeoutMs);
    this.hardTimer = setTimeout(() => this.fireHard(), this.limits.hardTimeoutMs);
  }

  private fireIdle(): void {
    if (this.disposed) return;
    this.onIdleTimeout();
  }

  private fireHard(): void {
    if (this.disposed) return;
    this.onHardTimeout();
  }

  recordActivity(): void {
    if (this.disposed) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.fireIdle(), this.limits.idleTimeoutMs);
  }

  bufferAudio(durationMs: number): void {
    this.bufferedMs += durationMs;
  }

  drainAudio(durationMs: number): void {
    this.bufferedMs = Math.max(0, this.bufferedMs - durationMs);
  }

  isBufferFull(): boolean {
    return this.bufferedMs >= this.limits.maxBufferedAudioMs;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.hardTimer);
  }
}

/** Rejects a new session once maxConcurrentSessions is reached. */
export class SessionRegistry {
  private count = 0;

  constructor(private readonly maxConcurrentSessions: number) {}

  tryAcquire(): boolean {
    if (this.count >= this.maxConcurrentSessions) return false;
    this.count += 1;
    return true;
  }

  release(): void {
    this.count = Math.max(0, this.count - 1);
  }

  get size(): number {
    return this.count;
  }
}
