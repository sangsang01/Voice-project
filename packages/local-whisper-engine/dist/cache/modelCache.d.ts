import { LOCAL_MODEL } from "../modelManifest.js";
export { LOCAL_MODEL };
export declare const MODEL_CACHE_KEY = "local-whisper-model";
export declare const DEFAULT_MODEL_STORAGE_BYTES: number;
export interface ModelCacheMetadata {
    modelId: string;
    revision: string;
    cacheVersion: number;
    complete: boolean;
}
export interface ModelCacheStore {
    get(key: string): Promise<ModelCacheMetadata | undefined>;
    set(key: string, metadata: ModelCacheMetadata): Promise<void>;
    delete(key: string): Promise<void>;
    estimate?(): Promise<{
        quota?: number;
        usage?: number;
    }>;
}
export interface CacheProgressEvent {
    type: "progress";
    progress: number;
}
export interface StorageWarning {
    code: "INSUFFICIENT_STORAGE";
    availableBytes: number;
    requiredBytes: number;
}
export interface PrepareModelCacheOptions {
    store: ModelCacheStore;
    requiredBytes?: number;
    download(reportProgress: (progress: number) => void): Promise<void>;
    onProgress?(event: CacheProgressEvent): void;
}
export interface PrepareModelCacheResult {
    status: "reused" | "downloaded";
    warnings: StorageWarning[];
}
export declare function prepareModelCache({ store, requiredBytes, download, onProgress, }: PrepareModelCacheOptions): Promise<PrepareModelCacheResult>;
