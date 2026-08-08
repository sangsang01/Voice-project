import { describe, expect, it, vi } from "vitest";

import { loadModelAsset } from "../src/cache/modelAssets.js";

function fakeCaches() {
  const store = new Map<string, Response>();
  return {
    store,
    caches: {
      async open() {
        return {
          async match(key: string) {
            const hit = store.get(key);
            return hit ? hit.clone() : undefined;
          },
          async put(key: string, response: Response) {
            store.set(key, response.clone());
          },
        };
      },
    },
  };
}

const bytes = () => new Uint8Array([1, 2, 3, 4]).buffer;

describe("loadModelAsset", () => {
  it("fetches from our own origin and caches the result", async () => {
    const { caches, store } = fakeCaches();
    const fetchSpy = vi.fn(async () => new Response(bytes(), { headers: { "content-length": "4" } }));

    const buffer = await loadModelAsset("ggml-tiny-q5_1.bin", { caches, fetch: fetchSpy as unknown as typeof fetch });

    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/models/ggml-tiny-q5_1.bin");
    expect(store.size).toBe(1);
  });

  it("serves the second load from cache without refetching", async () => {
    const { caches } = fakeCaches();
    const fetchSpy = vi.fn(async () => new Response(bytes(), { headers: { "content-length": "4" } }));
    const options = { caches, fetch: fetchSpy as unknown as typeof fetch };

    await loadModelAsset("ggml-tiny-q5_1.bin", options);
    const second = await loadModelAsset("ggml-tiny-q5_1.bin", options);

    expect(new Uint8Array(second)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("reports progress reaching 1", async () => {
    const { caches } = fakeCaches();
    const progress: number[] = [];

    await loadModelAsset("ggml-tiny-q5_1.bin", {
      caches,
      fetch: (async () => new Response(bytes(), { headers: { "content-length": "4" } })) as unknown as typeof fetch,
      onProgress: (value) => progress.push(value),
    });

    expect(progress.at(-1)).toBe(1);
  });

  it("throws a diagnosable error when the weights are missing", async () => {
    const { caches } = fakeCaches();

    await expect(
      loadModelAsset("ggml-tiny-q5_1.bin", {
        caches,
        fetch: (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/npm run fetch-models/);
  });

  it("falls back to a plain fetch when the Cache API is unavailable", async () => {
    const original = (globalThis as { caches?: unknown }).caches;
    delete (globalThis as { caches?: unknown }).caches;

    try {
      const fetchSpy = vi.fn(async () => new Response(bytes(), { headers: { "content-length": "4" } }));

      const buffer = await loadModelAsset("ggml-tiny-q5_1.bin", {
        fetch: fetchSpy as unknown as typeof fetch,
      });

      expect(new Uint8Array(buffer)).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      (globalThis as { caches?: unknown }).caches = original;
    }
  });

  it("returns correct bytes and finishes progress at 1 when content-length is missing", async () => {
    const { caches } = fakeCaches();
    const progress: number[] = [];

    const buffer = await loadModelAsset("ggml-tiny-q5_1.bin", {
      caches,
      fetch: (async () => new Response(bytes())) as unknown as typeof fetch,
      onProgress: (value) => progress.push(value),
    });

    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(progress.at(-1)).toBe(1);
  });

  it("returns correct bytes when response.body is null", async () => {
    const { caches } = fakeCaches();
    const expected = new Uint8Array([1, 2, 3, 4]);
    const fakeResponse = {
      ok: true,
      status: 200,
      body: null,
      headers: { get: (name: string) => (name === "content-length" ? "4" : null) },
      async arrayBuffer() {
        return expected.buffer;
      },
      clone() {
        return fakeResponse;
      },
    } as unknown as Response;

    const buffer = await loadModelAsset("ggml-tiny-q5_1.bin", {
      caches,
      fetch: (async () => fakeResponse) as unknown as typeof fetch,
      onProgress: () => {},
    });

    expect(new Uint8Array(buffer)).toEqual(expected);
  });

  function streamResponse(actualBytes: Uint8Array, headerContentLength: string) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(actualBytes);
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-length": headerContentLength } });
  }

  it("trusts the actual bytes over a content-length header that overstates the size", async () => {
    const { caches } = fakeCaches();
    const actual = new Uint8Array([1, 2, 3, 4]);
    const progress: number[] = [];

    const buffer = await loadModelAsset("ggml-tiny-q5_1.bin", {
      caches,
      fetch: (async () => streamResponse(actual, "100")) as unknown as typeof fetch,
      onProgress: (value) => progress.push(value),
    });

    expect(new Uint8Array(buffer)).toEqual(actual);
    expect(progress.every((value) => value <= 1)).toBe(true);
  });

  it("trusts the actual bytes over a content-length header that understates the size", async () => {
    const { caches } = fakeCaches();
    const actual = new Uint8Array([1, 2, 3, 4]);
    const progress: number[] = [];

    const buffer = await loadModelAsset("ggml-tiny-q5_1.bin", {
      caches,
      fetch: (async () => streamResponse(actual, "2")) as unknown as typeof fetch,
      onProgress: (value) => progress.push(value),
    });

    expect(new Uint8Array(buffer)).toEqual(actual);
    expect(progress.every((value) => value <= 1)).toBe(true);
  });
});
