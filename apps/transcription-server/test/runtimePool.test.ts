import { makeSessionRequest } from "@voice/transcription-contracts/testing";
import type { NativeRuntimeHandle } from "@voice/native-whisper-addon";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimePool } from "../src/runtimePool.js";

interface FakeHandleTracker {
  created: number;
  warmups: number;
  resets: number;
  closes: number;
  activeDecodes: number;
  maxConcurrentDecodes: number;
  decodeStarts: number[];
  handles: FakeHandle[];
}

class FakeHandle implements NativeRuntimeHandle {
  public closed = false;
  public decodeImpl: ((samples: Int16Array, prompt: string) => Promise<{
    text: string;
    language: string;
    startMs: number;
    endMs: number;
  }>) | undefined;

  public constructor(private readonly tracker: FakeHandleTracker) {
    tracker.created += 1;
    tracker.handles.push(this);
  }

  public pushVad(_samples: Int16Array): Float32Array {
    return new Float32Array([0.1]);
  }

  public async decode(samples: Int16Array, prompt: string) {
    this.tracker.decodeStarts.push(Date.now());
    this.tracker.activeDecodes += 1;
    this.tracker.maxConcurrentDecodes = Math.max(
      this.tracker.maxConcurrentDecodes,
      this.tracker.activeDecodes,
    );
    try {
      if (this.decodeImpl) return await this.decodeImpl(samples, prompt);
      return {
        text: `decoded:${prompt}`,
        language: "en",
        startMs: 0,
        endMs: Math.max(20, Math.floor((samples.length * 1000) / 16_000)),
      };
    } finally {
      this.tracker.activeDecodes -= 1;
    }
  }

  public async warmup(): Promise<void> {
    this.tracker.warmups += 1;
  }

  public reset(): void {
    this.tracker.resets += 1;
  }

  public close(): void {
    this.closed = true;
    this.tracker.closes += 1;
  }
}

function createTracker(): FakeHandleTracker {
  return {
    created: 0,
    warmups: 0,
    resets: 0,
    closes: 0,
    activeDecodes: 0,
    maxConcurrentDecodes: 0,
    decodeStarts: [],
    handles: [],
  };
}

describe("RuntimePool", () => {
  const pools: RuntimePool[] = [];

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (pool) await pool.shutdown({ drainTimeoutMs: 100 });
    }
  });

  async function createPool(
    tracker: FakeHandleTracker,
    options?: { capacity?: number; decodeTimeoutMs?: number },
  ): Promise<RuntimePool> {
    const pool = await RuntimePool.create({
      modelName: "fake-whisper-small",
      capacity: options?.capacity ?? 4,
      decodeTimeoutMs: options?.decodeTimeoutMs ?? 30_000,
      createHandle: () => new FakeHandle(tracker),
    });
    pools.push(pool);
    return pool;
  }

  it("creates and warms exactly capacity handles at startup", async () => {
    const tracker = createTracker();
    await createPool(tracker, { capacity: 4 });
    expect(tracker.created).toBe(4);
    expect(tracker.warmups).toBe(4);
  });

  it("reserves one handle per open session and releases it on close", async () => {
    const tracker = createTracker();
    const pool = await createPool(tracker, { capacity: 2 });
    const request = makeSessionRequest(["en-US"]);

    const first = await pool.open(request);
    const second = await pool.open(request);
    expect(tracker.created).toBe(2);

    await first.close();
    expect(tracker.resets).toBe(1);

    const third = await pool.open(request);
    expect(tracker.created).toBe(2);

    await second.close();
    await third.close();
    expect(tracker.resets).toBe(3);
  });

  it("serializes provisional and final decode calls per handle", async () => {
    const tracker = createTracker();
    const pool = await createPool(tracker, { capacity: 1 });
    const session = await pool.open(makeSessionRequest(["en-US"]));

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const handle = tracker.handles[0]!;
    handle.decodeImpl = async () => {
      await firstGate;
      return { text: "one", language: "en", startMs: 0, endMs: 20 };
    };

    const audio = new Int16Array(320);
    const first = session.decode("provisional", audio, "");
    const second = session.decode("final", audio, "one");

    await Promise.resolve();
    expect(tracker.activeDecodes).toBe(1);

    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.text).toBe("one");
    expect(secondResult.text).toBe("one");
    expect(tracker.maxConcurrentDecodes).toBe(1);

    await session.close();
  });

  it("rejects the fifth reservation when capacity is four", async () => {
    const tracker = createTracker();
    const pool = await createPool(tracker, { capacity: 4 });
    const request = makeSessionRequest(["en-US"]);
    const sessions = [];
    for (let index = 0; index < 4; index += 1) {
      sessions.push(await pool.open(request));
    }

    await expect(pool.open(request)).rejects.toThrow(/capacity|exhausted|available/i);

    await Promise.all(sessions.map((session) => session.close()));
  });

  it("replaces a timed-out handle before readmission", async () => {
    const tracker = createTracker();
    const pool = await createPool(tracker, { capacity: 1, decodeTimeoutMs: 30 });
    const session = await pool.open(makeSessionRequest(["en-US"]));

    const handle = tracker.handles[0]!;
    handle.decodeImpl = () =>
      new Promise(() => {
        // Never resolves — forces the pool timeout path.
      });

    await expect(session.decode("provisional", new Int16Array(320), "")).rejects.toThrow(/timeout/i);
    await session.close();

    expect(handle.closed).toBe(true);
    expect(tracker.closes).toBeGreaterThanOrEqual(1);

    const replacement = await pool.open(makeSessionRequest(["en-US"]));
    expect(tracker.created).toBe(2);
    expect(tracker.warmups).toBe(2);
    expect(tracker.handles[1]!.closed).toBe(false);

    await replacement.close();
  });

  it("destroys all handles once on shutdown", async () => {
    const tracker = createTracker();
    const pool = await RuntimePool.create({
      modelName: "fake-whisper-small",
      capacity: 3,
      createHandle: () => new FakeHandle(tracker),
    });

    const session = await pool.open(makeSessionRequest(["en-US"]));
    await session.close();

    await pool.shutdown({ drainTimeoutMs: 100 });
    expect(tracker.closes).toBe(3);

    await pool.shutdown({ drainTimeoutMs: 100 });
    expect(tracker.closes).toBe(3);
  });

  it("feeds pushVad probabilities through VadGate into speech boundary updates", async () => {
    const tracker = createTracker();
    const pool = await createPool(tracker, { capacity: 1 });
    const session = await pool.open(makeSessionRequest(["en-US"]));

    const handle = tracker.handles[0]!;
    let pushCount = 0;
    handle.pushVad = () => {
      pushCount += 1;
      // One Silero window per push; high then low probabilities.
      return new Float32Array([pushCount <= 10 ? 0.9 : 0.1]);
    };

    const frame = {
      sequence: 0,
      startMs: 0,
      samples: new Int16Array(320),
    };

    let started = false;
    let ended = false;
    for (let index = 0; index < 40; index += 1) {
      const update = session.push({
        ...frame,
        sequence: index,
        startMs: index * 20,
      });
      if (update.speechStarted) started = true;
      if (update.speechEnded) ended = true;
    }

    expect(started).toBe(true);
    expect(ended).toBe(true);
    await session.close();
  });
});
