export interface CacheLike {
    match(key: string): Promise<Response | undefined>;
    put(key: string, response: Response): Promise<void>;
}
export interface CacheStorageLike {
    open(name: string): Promise<CacheLike>;
}
export interface LoadModelAssetOptions {
    onProgress?(fraction: number): void;
    caches?: CacheStorageLike;
    fetch?: typeof fetch;
    basePath?: string;
}
/**
 * Weights are served from our own origin (see scripts/fetch-models.mjs) and
 * kept in the Cache API so a reload never re-downloads them. The explicit cache
 * also gives us a byte-accurate progress signal, which the HTTP cache does not.
 */
export declare function loadModelAsset(fileName: string, options?: LoadModelAssetOptions): Promise<ArrayBuffer>;
