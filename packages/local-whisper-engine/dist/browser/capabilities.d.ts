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
export declare function inspectLocalCapabilities(environment?: LocalCapabilityEnvironment): Promise<LocalCapabilities>;
