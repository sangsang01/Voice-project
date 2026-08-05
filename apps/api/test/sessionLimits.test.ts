import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS, isAllowedOrigin, loadConfig } from "../src/config";
import { SessionLimits, SessionRegistry } from "../src/websocket/sessionLimits";

describe("DEFAULT_LIMITS", () => {
  it("matches the documented safe defaults", () => {
    expect(DEFAULT_LIMITS).toEqual({
      idleTimeoutMs: 30_000,
      hardTimeoutMs: 600_000,
      frameBytes: 640,
      maxBufferedAudioMs: 2_000,
      maxConcurrentSessions: 20,
    });
  });

  it("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
  });
});

describe("loadConfig", () => {
  it("requires ALLOWED_ORIGINS outside test mode", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(RangeError);
  });

  it("allows a missing ALLOWED_ORIGINS in test mode", () => {
    expect(() => loadConfig({ NODE_ENV: "test" })).not.toThrow();
  });

  it.each(["-1", "0", "1.5", "not-a-number"])("rejects a non-positive-integer override %s", (raw) => {
    expect(() => loadConfig({ NODE_ENV: "test", IDLE_TIMEOUT_MS: raw })).toThrow(RangeError);
  });

  it("rejects a value above the documented safe ceiling", () => {
    expect(() => loadConfig({ NODE_ENV: "test", HARD_TIMEOUT_MS: String(31 * 60_000) })).toThrow(RangeError);
  });

  it("accepts a lowered override within the safe ceiling", () => {
    const config = loadConfig({ NODE_ENV: "test", IDLE_TIMEOUT_MS: "5000" });
    expect(config.limits.idleTimeoutMs).toBe(5000);
  });
});

describe("isAllowedOrigin", () => {
  const allowedOrigins = ["https://app.example.com"];

  it("accepts an exact origin match", () => {
    expect(isAllowedOrigin("https://app.example.com", allowedOrigins)).toBe(true);
  });

  it.each([
    "https://evil.example.com",
    "http://app.example.com",
    "https://app.example.com.evil.com",
    "https://app.example.com:8080",
    undefined,
  ])("rejects a non-exact match: %s", (origin) => {
    expect(isAllowedOrigin(origin, allowedOrigins)).toBe(false);
  });
});

describe("SessionLimits", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const limits = { ...DEFAULT_LIMITS };

  it("does not fire the idle timeout one millisecond before the deadline", () => {
    const onIdleTimeout = vi.fn();
    const session = new SessionLimits({ limits, onIdleTimeout, onHardTimeout: vi.fn() });
    vi.advanceTimersByTime(limits.idleTimeoutMs - 1);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    session.dispose();
  });

  it("fires the idle timeout exactly at the deadline", () => {
    const onIdleTimeout = vi.fn();
    const session = new SessionLimits({ limits, onIdleTimeout, onHardTimeout: vi.fn() });
    vi.advanceTimersByTime(limits.idleTimeoutMs);
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("resets the idle timer only after recordActivity is called", () => {
    const onIdleTimeout = vi.fn();
    const session = new SessionLimits({ limits, onIdleTimeout, onHardTimeout: vi.fn() });
    vi.advanceTimersByTime(limits.idleTimeoutMs - 1);
    session.recordActivity();
    vi.advanceTimersByTime(limits.idleTimeoutMs - 1);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("does not fire the hard timeout one millisecond before the deadline", () => {
    const onHardTimeout = vi.fn();
    const session = new SessionLimits({ limits, onIdleTimeout: vi.fn(), onHardTimeout });
    vi.advanceTimersByTime(limits.hardTimeoutMs - 1);
    expect(onHardTimeout).not.toHaveBeenCalled();
    session.dispose();
  });

  it("fires the hard timeout exactly at the deadline regardless of intervening activity", () => {
    const onHardTimeout = vi.fn();
    const session = new SessionLimits({ limits, onIdleTimeout: vi.fn(), onHardTimeout });
    vi.advanceTimersByTime(limits.hardTimeoutMs / 2);
    session.recordActivity();
    vi.advanceTimersByTime(limits.hardTimeoutMs / 2);
    expect(onHardTimeout).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("never fires either timeout after dispose", () => {
    const onIdleTimeout = vi.fn();
    const onHardTimeout = vi.fn();
    const session = new SessionLimits({ limits, onIdleTimeout, onHardTimeout });
    session.dispose();
    vi.advanceTimersByTime(limits.hardTimeoutMs);
    expect(onIdleTimeout).not.toHaveBeenCalled();
    expect(onHardTimeout).not.toHaveBeenCalled();
  });

  it("reports the buffer full at exactly maxBufferedAudioMs of queued audio", () => {
    const session = new SessionLimits({ limits, onIdleTimeout: vi.fn(), onHardTimeout: vi.fn() });
    session.bufferAudio(limits.maxBufferedAudioMs - 20);
    expect(session.isBufferFull()).toBe(false);
    session.bufferAudio(20);
    expect(session.isBufferFull()).toBe(true);
    session.drainAudio(20);
    expect(session.isBufferFull()).toBe(false);
    session.dispose();
  });
});

describe("SessionRegistry", () => {
  it("rejects a new session once the configured concurrency limit is reached", () => {
    const registry = new SessionRegistry(2);
    expect(registry.tryAcquire()).toBe(true);
    expect(registry.tryAcquire()).toBe(true);
    expect(registry.tryAcquire()).toBe(false);
    expect(registry.size).toBe(2);
  });

  it("accepts a new session after one is released", () => {
    const registry = new SessionRegistry(1);
    expect(registry.tryAcquire()).toBe(true);
    expect(registry.tryAcquire()).toBe(false);
    registry.release();
    expect(registry.tryAcquire()).toBe(true);
  });
});
