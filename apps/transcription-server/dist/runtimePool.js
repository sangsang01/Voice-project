import { createNativeRuntimeSession } from "./nativeRuntime.js";
const DEFAULT_DECODE_TIMEOUT_MS = 30_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
/**
 * Fixed pool of warm native whisper handles. Each open() leases one handle as a
 * StreamingRuntimeSession; healthy releases are reset and reused, while failed
 * or timed-out handles are closed and replaced before the slot is readmitted.
 */
export class RuntimePool {
    modelName;
    createHandle;
    capacity;
    decodeTimeoutMs;
    idle = [];
    leased = new Set();
    admitting = true;
    shuttingDown = false;
    closedHandles = new WeakSet();
    drainWaiters = [];
    constructor(options) {
        if (!Number.isInteger(options.capacity) || options.capacity < 1) {
            throw new Error("RuntimePool capacity must be a positive integer");
        }
        this.createHandle = options.createHandle;
        this.capacity = options.capacity;
        this.modelName = options.modelName;
        this.decodeTimeoutMs = options.decodeTimeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS;
    }
    static async create(options) {
        const pool = new RuntimePool(options);
        for (let index = 0; index < options.capacity; index += 1) {
            const handle = options.createHandle();
            await handle.warmup();
            pool.idle.push(handle);
        }
        return pool;
    }
    stopAdmission() {
        this.admitting = false;
    }
    async open(_request) {
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
    async shutdown(options = {}) {
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
    async releaseHandle(handle, outcome) {
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
            let replacement;
            try {
                replacement = this.createHandle();
                await replacement.warmup();
                if (this.shuttingDown) {
                    this.closeHandleOnce(replacement);
                    return;
                }
                this.idle.push(replacement);
            }
            catch (error) {
                if (replacement)
                    this.closeHandleOnce(replacement);
                // Preserve capacity: try one more replacement so a transient warmup
                // failure does not permanently shrink the pool.
                let retry;
                try {
                    retry = this.createHandle();
                    await retry.warmup();
                    if (this.shuttingDown) {
                        this.closeHandleOnce(retry);
                        return;
                    }
                    this.idle.push(retry);
                }
                catch (retryError) {
                    if (retry)
                        this.closeHandleOnce(retry);
                    throw retryError instanceof Error ? retryError : error;
                }
            }
        }
        finally {
            this.notifyDrainWaiters();
        }
    }
    async waitForDrain(timeoutMs) {
        if (this.leased.size === 0)
            return;
        await new Promise((resolve) => {
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
    notifyDrainWaiters() {
        const waiters = [...this.drainWaiters];
        for (const waiter of waiters)
            waiter();
    }
    closeAllHandles() {
        while (this.idle.length > 0) {
            const handle = this.idle.pop();
            if (handle)
                this.closeHandleOnce(handle);
        }
        for (const handle of [...this.leased]) {
            this.closeHandleOnce(handle);
            this.leased.delete(handle);
        }
    }
    closeHandleOnce(handle) {
        if (this.closedHandles.has(handle))
            return;
        this.closedHandles.add(handle);
        handle.close();
    }
}
