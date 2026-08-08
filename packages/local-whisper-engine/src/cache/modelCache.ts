import { LOCAL_MODEL } from "../modelManifest.js";

export { LOCAL_MODEL };

export const MODEL_CACHE_KEY = "local-whisper-model";
// whisper-small (q8, encoder + decoder) is ~240MB on disk; leave headroom above that.
export const DEFAULT_MODEL_STORAGE_BYTES = 400 * 1024 * 1024;

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
  estimate?(): Promise<{ quota?: number; usage?: number }>;
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

function expectedMetadata(complete: boolean): ModelCacheMetadata {
  return {
    modelId: LOCAL_MODEL.id,
    revision: LOCAL_MODEL.revision,
    cacheVersion: LOCAL_MODEL.cacheVersion,
    complete,
  };
}

function isReusable(metadata: ModelCacheMetadata | undefined): boolean {
  return (
    metadata?.modelId === LOCAL_MODEL.id &&
    metadata.revision === LOCAL_MODEL.revision &&
    metadata.cacheVersion === LOCAL_MODEL.cacheVersion &&
    metadata.complete
  );
}

async function storageWarnings(
  store: ModelCacheStore,
  requiredBytes: number,
): Promise<StorageWarning[]> {
  const estimate = await store.estimate?.();
  if (typeof estimate?.quota !== "number" || typeof estimate.usage !== "number") {
    return [];
  }

  const availableBytes = Math.max(0, estimate.quota - estimate.usage);
  return availableBytes < requiredBytes
    ? [{ code: "INSUFFICIENT_STORAGE", availableBytes, requiredBytes }]
    : [];
}

export async function prepareModelCache({
  store,
  requiredBytes = DEFAULT_MODEL_STORAGE_BYTES,
  download,
  onProgress,
}: PrepareModelCacheOptions): Promise<PrepareModelCacheResult> {
  const cached = await store.get(MODEL_CACHE_KEY);
  if (isReusable(cached)) {
    return { status: "reused", warnings: [] };
  }

  if (cached) {
    await store.delete(MODEL_CACHE_KEY);
  }

  const warnings = await storageWarnings(store, requiredBytes);
  await store.set(MODEL_CACHE_KEY, expectedMetadata(false));
  await download((progress) => onProgress?.({ type: "progress", progress }));
  await store.set(MODEL_CACHE_KEY, expectedMetadata(true));

  return { status: "downloaded", warnings };
}
