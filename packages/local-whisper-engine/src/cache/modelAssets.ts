import { LOCAL_MODEL } from "../modelManifest.js";

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

const cacheName = () => `whisper-models-v${LOCAL_MODEL.cacheVersion}`;

/**
 * Weights are served from our own origin (see scripts/fetch-models.mjs) and
 * kept in the Cache API so a reload never re-downloads them. The explicit cache
 * also gives us a byte-accurate progress signal, which the HTTP cache does not.
 */
export async function loadModelAsset(
  fileName: string,
  options: LoadModelAssetOptions = {},
): Promise<ArrayBuffer> {
  const store = options.caches ?? (globalThis.caches as unknown as CacheStorageLike | undefined);
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${options.basePath ?? LOCAL_MODEL.basePath}/${fileName}`;

  const cache = await store?.open(cacheName());
  const cached = await cache?.match(url);
  if (cached) {
    options.onProgress?.(1);
    return cached.arrayBuffer();
  }

  const response = await doFetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not load ${fileName} (HTTP ${response.status}). Run "npm run fetch-models" to download the model weights.`,
    );
  }

  const buffer = await readWithProgress(response, options.onProgress);
  await cache?.put(url, new Response(buffer.slice(0)));
  options.onProgress?.(1);
  return buffer;
}

async function readWithProgress(
  response: Response,
  onProgress?: (fraction: number) => void,
): Promise<ArrayBuffer> {
  const total = Number(response.headers.get("content-length") ?? 0);
  if (!response.body || !onProgress || total <= 0) {
    return response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(Math.min(1, received / total));
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}
