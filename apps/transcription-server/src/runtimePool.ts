import type { SessionRequest } from "@voice/transcription-contracts";
import type { NativeRuntimeHandle } from "@voice/native-whisper-addon";

import { createNativeRuntimeSession } from "./nativeRuntime.js";
import type { StreamingRuntime, StreamingRuntimeSession } from "./runtime.js";

export interface RuntimePoolOptions {
  createHandle: () => NativeRuntimeHandle;
  capacity: number;
  modelName: string;
  decodeTimeoutMs?: number;
}

export interface RuntimePoolShutdownOptions {
  drainTimeoutMs?: number;
}

const DEFAULT_DECODE_TIMEOUT_MS = 30_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Fixed pool of warm native whisper handles. Each open() leases one handle as a
 * StreamingRuntimeSession; healthy releases are reset and reused, while failed
 * or timed-out handles are closed and replaced before the slot is readmitted.
 */
export class RuntimePool implements StreamingRuntime {
  public readonly modelName: string;

  private readonly createHandle: () => NativeRuntimeHandle;
  private readonly capacity: number;
  private readonly decodeTimeoutMs: number;
  private readonly idle: NativeRuntimeHandle[] = [];
  private readonly leased = new Set<NativeRuntimeHandle>();
  private admitting = true;
  private shuttingDown = false;
  private closedHandles = new WeakSet<NativeRuntimeHandle>();
  private drainWaiters: Array<() => void> = [];

  private constructor(options: RuntimePoolOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new Error("RuntimePool capacity must be a positive integer");
    }
    this.createHandle = options.createHandle;
    this.capacity = options.capacity;
    this.modelName = options.modelName;
    this.decodeTimeoutMs = options.decodeTimeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS;
  }

  public static async create(options: RuntimePoolOptions): Promise<RuntimePool> {
    const pool = new RuntimePool(options);
    for (let index = 0; index < options.capacity; index += 1) {
      const handle = options.createHandle();
      await handle.warmup();
      pool.idle.push(handle);
    }
    return pool;
  }

  public stopAdmission(): void {
    this.admitting = false;
  }

  public async open(_request: SessionRequest): Promise<StreamingRuntimeSession> {
    if (!this.admitting || this.shuttingDown) {
      throw new Error("runtime pool is not accepting sessions");
    }
    const handle = this.idle.pop();
    if (!handle) {
      throw new Error("runtime pool capacity exhausted");
    }
    this.leased.add(handle);

    return createNativeRuntimeSession({
      handle,
      decodeTimeoutMs: this.decodeTimeoutMs,
      release: async (outcome) => {
        await this.releaseHandle(handle, outcome);
      },
    });
  }

  public async shutdown(options: RuntimePoolShutdownOptions = {}): Promise<void> {
    if (this.shuttingDown) {
      await this.waitForDrain(options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
      this.closeAllHandles();
      return;
    }

    this.shuttingDown = true;
    this.admitting = false;
    await this.waitForDrain(options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
    this.closeAllHandles();
  }

  private async releaseHandle(
    handle: NativeRuntimeHandle,
    outcome: "healthy" | "unhealthy",
  ): Promise<void> {
    this.leased.delete(handle);

    try {
      if (this.shuttingDown) {
        this.closeHandleOnce(handle);
        return;
      }

      if (outcome === "healthy") {
        handle.reset();
        this.idle.push(handle);
        return;
      }

      this.closeHandleOnce(handle);
      const replacement = this.createHandle();
      await replacement.warmup();
      if (this.shuttingDown) {
        this.closeHandleOnce(replacement);
        return;
      }
      this.idle.push(replacement);
    } finally {
      this.notifyDrainWaiters();
    }
  }

  private async waitForDrain(timeoutMs: number): Promise<void> {
    if (this.leased.size === 0) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.drainWaiters = this.drainWaiters.filter((waiter) => waiter !== onDrain);
        resolve();
      }, timeoutMs);

      const onDrain = () => {
        if (this.leased.size === 0) {
          clearTimeout(timer);
          resolve();
        }
      };
      this.drainWaiters.push(onDrain);
      onDrain();
    });
  }

  private notifyDrainWaiters(): void {
    const waiters = [...this.drainWaiters];
    for (const waiter of waiters) waiter();
  }

  private closeAllHandles(): void {
    while (this.idle.length > 0) {
      const handle = this.idle.pop();
      if (handle) this.closeHandleOnce(handle);
    }
    for (const handle of [...this.leased]) {
      this.closeHandleOnce(handle);
      this.leased.delete(handle);
    }
  }

  private closeHandleOnce(handle: NativeRuntimeHandle): void {
    if (this.closedHandles.has(handle)) return;
    this.closedHandles.add(handle);
    handle.close();
  }
}
