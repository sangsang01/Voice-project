#!/usr/bin/env node
// Runs from the root postinstall. Downloads the whisper and Silero VAD weights
// once into apps/web/public/models (gitignored) so the browser never talks to
// huggingface.co at runtime.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "apps", "web", "public", "models");

// Expected hashes are pinned here (not derived from whatever we happen to
// download) so a wrong, truncated, or tampered download is caught on the very
// first run instead of being silently enshrined as "correct".
const MODELS = [
  {
    file: "ggml-tiny-q5_1.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q5_1.bin",
    sha256: "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7",
  },
  {
    file: "ggml-silero-v6.2.0.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
    sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
  },
];

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function download({ file, url, sha256: expectedHash }) {
  const target = join(outDir, file);
  // Older versions of this script wrote a self-recorded sidecar hash, which
  // gave no protection against a bad first download. It's no longer read or
  // trusted as a source of truth; drop any stale copy left on disk.
  rmSync(`${target}.sha256`, { force: true });

  if (existsSync(target) && sha256(readFileSync(target)) === expectedHash) {
    console.log(`models: ${file} already present`);
    return;
  }

  console.log(`models: downloading ${file}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to download ${file}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`failed to download ${file}: empty response`);
  }

  const actualHash = sha256(bytes);
  if (actualHash !== expectedHash) {
    throw new Error(
      `checksum mismatch for ${file}: expected ${expectedHash}, got ${actualHash}`,
    );
  }

  // Write to a temp name first so an interrupted run never leaves a truncated
  // file that looks valid to the next one.
  const temp = `${target}.partial`;
  writeFileSync(temp, bytes);
  renameSync(temp, target);
  console.log(`models: wrote ${file} (${(bytes.byteLength / 1e6).toFixed(1)} MB)`);
}

mkdirSync(outDir, { recursive: true });
try {
  for (const model of MODELS) {
    await download(model);
  }
} catch (error) {
  rmSync(join(outDir, "ggml-tiny-q5_1.bin.partial"), { force: true });
  rmSync(join(outDir, "ggml-silero-v6.2.0.bin.partial"), { force: true });
  console.error(`\n${error.message}`);
  console.error("Model download failed. Re-run with: npm run fetch-models");
  process.exit(1);
}
