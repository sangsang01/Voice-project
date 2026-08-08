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
    await loadModelAsset("ggml-tiny-q5_1.bin", options);

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
});
