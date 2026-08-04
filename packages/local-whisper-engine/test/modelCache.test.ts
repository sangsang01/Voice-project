import { describe, expect, it } from "vitest";

import {
  LOCAL_MODEL,
  MODEL_CACHE_KEY,
  type ModelCacheStore,
  prepareModelCache,
} from "../src/cache/modelCache.js";

function createStore(initial?: Awaited<ReturnType<ModelCacheStore["get"]>>) {
  let value = initial;
  const deleted: string[] = [];

  return {
    store: {
      get: async () => value,
      set: async (_key, metadata) => {
        value = metadata;
      },
      delete: async (key) => {
        deleted.push(key);
        value = undefined;
      },
      estimate: async () => ({ quota: 1_000, usage: 950 }),
    } satisfies ModelCacheStore,
    deleted,
    metadata: () => value,
  };
}

describe("prepareModelCache", () => {
  it("evicts an incompatible cache version before downloading", async () => {
    const fixture = createStore({
      modelId: LOCAL_MODEL.id,
      revision: LOCAL_MODEL.revision,
      cacheVersion: LOCAL_MODEL.cacheVersion - 1,
      complete: true,
    });
    const download = async () => undefined;

    const result = await prepareModelCache({ store: fixture.store, download });

    expect(fixture.deleted).toEqual([MODEL_CACHE_KEY]);
    expect(result.status).toBe("downloaded");
  });

  it("warns when browser storage is below the model requirement and relays progress", async () => {
    const fixture = createStore();
    const progress: number[] = [];

    const result = await prepareModelCache({
      store: fixture.store,
      requiredBytes: 100,
      download: async (reportProgress) => {
        reportProgress(0.25);
        reportProgress(1);
      },
      onProgress: (event) => progress.push(event.progress),
    });

    expect(result.warnings).toEqual([
      { code: "INSUFFICIENT_STORAGE", availableBytes: 50, requiredBytes: 100 },
    ]);
    expect(progress).toEqual([0.25, 1]);
  });

  it("marks interrupted downloads incomplete", async () => {
    const fixture = createStore();

    await expect(
      prepareModelCache({
        store: fixture.store,
        download: async () => {
          throw new Error("connection lost");
        },
      }),
    ).rejects.toThrow("connection lost");

    expect(fixture.metadata()).toEqual({
      modelId: LOCAL_MODEL.id,
      revision: LOCAL_MODEL.revision,
      cacheVersion: LOCAL_MODEL.cacheVersion,
      complete: false,
    });
  });

  it("reuses a complete matching cache without downloading", async () => {
    const fixture = createStore({
      modelId: LOCAL_MODEL.id,
      revision: LOCAL_MODEL.revision,
      cacheVersion: LOCAL_MODEL.cacheVersion,
      complete: true,
    });
    let downloads = 0;

    const result = await prepareModelCache({
      store: fixture.store,
      download: async () => {
        downloads += 1;
      },
    });

    expect(result.status).toBe("reused");
    expect(downloads).toBe(0);
  });
});
