import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertMultilingualModelFile,
  provisionModels,
} from "../scripts/modelProvisioning.lib.mjs";

type ModelEntry = { file: string; url: string; sha256: string };
type FetchLike = (url: string | URL) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function memoryFs(initial: Record<string, Buffer> = {}) {
  const files = new Map<string, Buffer>(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
  return {
    files,
    existsSync(path: string) {
      return files.has(path);
    },
    readFileSync(path: string) {
      const value = files.get(path);
      if (!value) throw new Error(`ENOENT: ${path}`);
      return Buffer.from(value);
    },
    writeFileSync(path: string, data: Buffer | Uint8Array) {
      files.set(path, Buffer.from(data));
    },
    renameSync(from: string, to: string) {
      const value = files.get(from);
      if (!value) throw new Error(`ENOENT: ${from}`);
      files.set(to, value);
      files.delete(from);
    },
    rmSync(path: string) {
      files.delete(path);
    },
    mkdirSync() {
      // no-op for in-memory seam
    },
  };
}

function okFetch(payloads: Record<string, Buffer>): FetchLike {
  return async (url) => {
    const body = payloads[String(url)];
    if (!body) {
      return {
        ok: false,
        status: 404,
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async arrayBuffer() {
        return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      },
    };
  };
}

describe("assertMultilingualModelFile", () => {
  it("rejects English-only .en model names", () => {
    expect(() => assertMultilingualModelFile("ggml-small.en.bin")).toThrow(/multilingual|\.en/i);
    expect(() => assertMultilingualModelFile("ggml-medium.en-q5_0.bin")).toThrow(/multilingual|\.en/i);
  });

  it("accepts multilingual whisper and silero names", () => {
    expect(() => assertMultilingualModelFile("ggml-small.bin")).not.toThrow();
    expect(() => assertMultilingualModelFile("ggml-medium.bin")).not.toThrow();
    expect(() => assertMultilingualModelFile("ggml-silero-v6.2.0.bin")).not.toThrow();
  });
});

describe("provisionModels", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses a valid cached model without refetching", async () => {
    const bytes = Buffer.from("cached-small-model-bytes");
    const entry: ModelEntry = {
      file: "ggml-small.bin",
      url: "https://example.test/ggml-small.bin",
      sha256: sha256(bytes),
    };
    const outDir = "/models";
    const fs = memoryFs({ [join(outDir, entry.file)]: bytes });
    let fetches = 0;
    const fetchImpl: FetchLike = async () => {
      fetches += 1;
      throw new Error("should not fetch");
    };

    const result = await provisionModels({
      models: [entry],
      outDir,
      fetchImpl,
      fs,
    });

    expect(result).toEqual([{ file: entry.file, status: "cached" }]);
    expect(fetches).toBe(0);
  });

  it("deletes a checksum-mismatched cache and refuses a bad download", async () => {
    const good = Buffer.from("good-bytes");
    const badCache = Buffer.from("tampered");
    const entry: ModelEntry = {
      file: "ggml-small.bin",
      url: "https://example.test/ggml-small.bin",
      sha256: sha256(good),
    };
    const outDir = "/models";
    const target = join(outDir, entry.file);
    const fs = memoryFs({ [target]: badCache });

    await expect(
      provisionModels({
        models: [entry],
        outDir,
        fetchImpl: okFetch({ [entry.url]: Buffer.from("wrong-download") }),
        fs,
      }),
    ).rejects.toThrow(/checksum mismatch/i);

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.partial`)).toBe(false);
  });

  it("cleans up a partial file after an interrupted download", async () => {
    const entry: ModelEntry = {
      file: "ggml-medium.bin",
      url: "https://example.test/ggml-medium.bin",
      sha256: sha256(Buffer.from("complete")),
    };
    const outDir = "/models";
    const fs = memoryFs();
    const fetchImpl: FetchLike = async () => {
      throw new Error("network reset");
    };

    await expect(
      provisionModels({
        models: [entry],
        outDir,
        fetchImpl,
        fs,
      }),
    ).rejects.toThrow(/network reset/);

    expect(fs.existsSync(join(outDir, entry.file))).toBe(false);
    expect(fs.existsSync(join(outDir, `${entry.file}.partial`))).toBe(false);
  });

  it("writes a verified download through a real temp directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-server-models-"));
    tempDirs.push(dir);
    const bytes = Buffer.from("silero-vad-bytes");
    const entry: ModelEntry = {
      file: "ggml-silero-v6.2.0.bin",
      url: "https://example.test/ggml-silero-v6.2.0.bin",
      sha256: sha256(bytes),
    };

    const result = await provisionModels({
      models: [entry],
      outDir: dir,
      fetchImpl: okFetch({ [entry.url]: bytes }),
    });

    expect(result).toEqual([{ file: entry.file, status: "downloaded" }]);
    const { readFileSync, existsSync } = await import("node:fs");
    expect(existsSync(join(dir, entry.file))).toBe(true);
    expect(sha256(readFileSync(join(dir, entry.file)))).toBe(entry.sha256);
    expect(existsSync(join(dir, `${entry.file}.partial`))).toBe(false);
  });

  it("rejects provisioning an English-only model entry", async () => {
    const entry: ModelEntry = {
      file: "ggml-small.en.bin",
      url: "https://example.test/ggml-small.en.bin",
      sha256: sha256(Buffer.from("en-only")),
    };

    await expect(
      provisionModels({
        models: [entry],
        outDir: "/models",
        fetchImpl: okFetch({}),
        fs: memoryFs(),
      }),
    ).rejects.toThrow(/multilingual|\.en/i);
  });
});
