import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODELS_DIR,
  SERVER_MODELS,
  provisionServerModels,
} from "../scripts/fetch-server-models.mjs";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createMemoryFs() {
  const files = new Map<string, Buffer>();
  const norm = (path: string) => path.replace(/\\/g, "/");
  return {
    files,
    mkdirSync: () => undefined,
    existsSync: (path: string) => files.has(norm(path)),
    readFileSync: (path: string) => {
      const data = files.get(norm(path));
      if (!data) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return data;
    },
    writeFileSync: (path: string, data: Buffer | Uint8Array | string) => {
      files.set(norm(path), Buffer.from(data));
    },
    renameSync: (from: string, to: string) => {
      const data = files.get(norm(from));
      if (!data) {
        throw Object.assign(new Error(`ENOENT: ${from}`), { code: "ENOENT" });
      }
      files.delete(norm(from));
      files.set(norm(to), data);
    },
    rmSync: (path: string) => {
      files.delete(norm(path));
    },
  };
}

const smallBytes = Buffer.from("small-model-bytes");
const vadBytes = Buffer.from("vad-model-bytes");
const mediumBytes = Buffer.from("medium-model-bytes");

const catalog = {
  base: {
    file: "ggml-base.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    sha256: sha256(Buffer.from("base-model-bytes")),
  },
  small: {
    file: "ggml-small.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    sha256: sha256(smallBytes),
  },
  medium: {
    file: "ggml-medium.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
    sha256: sha256(mediumBytes),
  },
  vad: {
    file: "ggml-silero-v6.2.0.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
    sha256: sha256(vadBytes),
  },
};

const modelsDir = join("apps", "transcription-server", "models");

function bodiesFor(url: string): Buffer {
  if (url.includes("ggml-small.bin")) return smallBytes;
  if (url.includes("ggml-silero-v6.2.0.bin")) return vadBytes;
  if (url.includes("ggml-medium.bin")) return mediumBytes;
  if (url.includes("ggml-base.bin")) return Buffer.from("base-model-bytes");
  throw new Error(`unexpected url ${url}`);
}

function trackingFetch(calls: string[], body = bodiesFor) {
  return async (url: string) => {
    calls.push(url);
    const bytes = body(url);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
}

describe("server model catalog", () => {
  it("pins live-path hashes and never lists an .en model", () => {
    expect(SERVER_MODELS.base).toEqual({
      file: "ggml-base.bin",
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
      sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    });
    expect(SERVER_MODELS.small).toEqual({
      file: "ggml-small.bin",
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
      sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    });
    expect(SERVER_MODELS.medium).toEqual({
      file: "ggml-medium.bin",
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
      sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
    });
    expect(SERVER_MODELS.vad).toEqual({
      file: "ggml-silero-v6.2.0.bin",
      url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
      sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
    });
    expect(Object.keys(SERVER_MODELS).some((name) => name.includes(".en"))).toBe(false);
    expect(DEFAULT_MODELS_DIR.replace(/\\/g, "/")).toMatch(/apps\/transcription-server\/models$/);
  });
});

describe("provisionServerModels", () => {
  it("reuses a matching sha256 cache and does not fetch again", async () => {
    const fs = createMemoryFs();
    const smallPath = join(modelsDir, "ggml-small.bin");
    const vadPath = join(modelsDir, "ggml-silero-v6.2.0.bin");
    fs.writeFileSync(smallPath, smallBytes);
    fs.writeFileSync(vadPath, vadBytes);
    const calls: string[] = [];

    await provisionServerModels({
      argv: ["--model", "small"],
      modelsDir,
      catalog,
      fetch: trackingFetch(calls),
      fs,
    });

    expect(calls).toEqual([]);
    expect(fs.readFileSync(smallPath)).toEqual(smallBytes);
  });

  it("deletes the partial file and throws on checksum mismatch", async () => {
    const fs = createMemoryFs();
    const calls: string[] = [];

    await expect(
      provisionServerModels({
        argv: ["--model", "small"],
        modelsDir,
        catalog,
        fetch: trackingFetch(calls, () => Buffer.from("tampered-bytes")),
        fs,
      }),
    ).rejects.toThrow(/checksum mismatch/i);

    const leftovers = [...fs.files.keys()].filter((path) => path.endsWith(".partial"));
    expect(leftovers).toEqual([]);
    expect(fs.existsSync(join(modelsDir, "ggml-small.bin"))).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("leaves no *.partial after an interrupted download error path", async () => {
    const fs = createMemoryFs();
    fs.writeFileSync(join(modelsDir, "ggml-small.bin.partial"), Buffer.from("stale"));

    await expect(
      provisionServerModels({
        argv: ["--model", "small"],
        modelsDir,
        catalog,
        fetch: async () => {
          throw new Error("network interrupted");
        },
        fs,
      }),
    ).rejects.toThrow(/network interrupted/);

    const leftovers = [...fs.files.keys()].filter((path) => path.endsWith(".partial"));
    expect(leftovers).toEqual([]);
  });

  it("throws before fetch when --model contains .en", async () => {
    const fs = createMemoryFs();
    const calls: string[] = [];

    await expect(
      provisionServerModels({
        argv: ["--model", "tiny.en"],
        modelsDir,
        catalog,
        fetch: trackingFetch(calls),
        fs,
      }),
    ).rejects.toThrow(/\.en/);

    await expect(
      provisionServerModels({
        argv: ["--model", "base.en"],
        modelsDir,
        catalog,
        fetch: trackingFetch(calls),
        fs,
      }),
    ).rejects.toThrow(/\.en/);

    expect(calls).toEqual([]);
  });

  it("writes apps/transcription-server/models/ggml-small.bin for --model small and fetches vad if missing", async () => {
    const fs = createMemoryFs();
    const calls: string[] = [];

    await provisionServerModels({
      argv: ["--model", "small"],
      modelsDir,
      catalog,
      fetch: trackingFetch(calls),
      fs,
    });

    const smallPath = join(modelsDir, "ggml-small.bin");
    expect(smallPath.replace(/\\/g, "/")).toBe("apps/transcription-server/models/ggml-small.bin");
    expect(fs.existsSync(smallPath)).toBe(true);
    expect(fs.readFileSync(smallPath)).toEqual(smallBytes);
    expect(fs.existsSync(join(modelsDir, "ggml-silero-v6.2.0.bin"))).toBe(true);
    expect(calls.some((url) => url.includes("ggml-small.bin"))).toBe(true);
    expect(calls.some((url) => url.includes("ggml-silero-v6.2.0.bin"))).toBe(true);
    expect(calls.some((url) => url.includes("ggml-medium.bin"))).toBe(false);
    expect(fs.existsSync(join(modelsDir, "ggml-medium.bin"))).toBe(false);
  });
});
