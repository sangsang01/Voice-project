export type LocalDevice = "webgpu" | "wasm" | "unavailable";

export interface StorageEstimate {
  quota?: number;
  usage?: number;
}

export interface BrowserStorage {
  estimate(): Promise<StorageEstimate>;
}

export interface LocalCapabilityEnvironment {
  gpu?: unknown;
  wasm?: unknown;
  storage?: BrowserStorage;
}

export interface LocalCapabilities {
  device: LocalDevice;
  storage: {
    quota?: number;
    usage?: number;
    available?: number;
  };
}

function defaultEnvironment(): LocalCapabilityEnvironment {
  const browserNavigator = typeof navigator === "undefined" ? undefined : navigator;

  return {
    gpu: browserNavigator?.gpu,
    wasm: typeof WebAssembly === "undefined" ? undefined : WebAssembly,
    storage: browserNavigator?.storage,
  };
}

export async function inspectLocalCapabilities(
  environment: LocalCapabilityEnvironment = defaultEnvironment(),
): Promise<LocalCapabilities> {
  const estimate = await environment.storage?.estimate();
  const quota = estimate?.quota;
  const usage = estimate?.usage;

  return {
    device: environment.gpu ? "webgpu" : environment.wasm ? "wasm" : "unavailable",
    storage: {
      quota,
      usage,
      available:
        typeof quota === "number" && typeof usage === "number"
          ? Math.max(0, quota - usage)
          : undefined,
    },
  };
}
