/**
 * Checksum-verified model provisioning for the transcription server.
 * Inject fetch/fs seams for unit tests; the CLI script wires Node defaults.
 */
import { createHash } from "node:crypto";
import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  renameSync as nodeRenameSync,
  rmSync as nodeRmSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { join } from "node:path";

const defaultFs = {
  existsSync: nodeExistsSync,
  readFileSync: (path) => nodeReadFileSync(path),
  writeFileSync: (path, data) => nodeWriteFileSync(path, data),
  renameSync: nodeRenameSync,
  rmSync: (path, options) => nodeRmSync(path, options),
  mkdirSync: (path, options) => nodeMkdirSync(path, options),
};

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** English-only whisper variants are prohibited for this multilingual service. */
export function assertMultilingualModelFile(file) {
  const name = file.split(/[/\\]/).pop() ?? file;
  if (/\.en(?:[.\-]|$)/i.test(name)) {
    throw new Error(`model must be multilingual; rejected English-only name: ${name}`);
  }
}

/**
 * @param {{
 *   models: ReadonlyArray<{ file: string, url: string, sha256: string }>,
 *   outDir: string,
 *   fetchImpl?: typeof fetch,
 *   fs?: typeof defaultFs,
 * }} options
 */
export async function provisionModels(options) {
  const fs = options.fs ?? defaultFs;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation is required");
  }

  fs.mkdirSync(options.outDir, { recursive: true });
  const results = [];

  for (const model of options.models) {
    assertMultilingualModelFile(model.file);
    results.push(await downloadOne(model, options.outDir, fetchImpl, fs));
  }

  return results;
}

async function downloadOne(model, outDir, fetchImpl, fs) {
  const target = join(outDir, model.file);
  const partial = `${target}.partial`;
  // Sidecar hashes are never trusted as a source of truth.
  fs.rmSync(`${target}.sha256`, { force: true });

  if (fs.existsSync(target)) {
    const cached = fs.readFileSync(target);
    if (sha256Hex(cached) === model.sha256) {
      return { file: model.file, status: "cached" };
    }
    fs.rmSync(target, { force: true });
  }

  fs.rmSync(partial, { force: true });

  try {
    const response = await fetchImpl(model.url);
    if (!response.ok) {
      throw new Error(`failed to download ${model.file}: HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new Error(`failed to download ${model.file}: empty response`);
    }

    const actual = sha256Hex(bytes);
    if (actual !== model.sha256) {
      throw new Error(`checksum mismatch for ${model.file}: expected ${model.sha256}, got ${actual}`);
    }

    fs.writeFileSync(partial, bytes);
    fs.renameSync(partial, target);
    return { file: model.file, status: "downloaded" };
  } catch (error) {
    fs.rmSync(partial, { force: true });
    if (fs.existsSync(target) && sha256Hex(fs.readFileSync(target)) !== model.sha256) {
      fs.rmSync(target, { force: true });
    }
    throw error;
  }
}
