#!/usr/bin/env node
// Runs from the root postinstall. Downloads the whisper and Silero VAD weights
// once into apps/web/public/models (gitignored) so the browser never talks to
// huggingface.co at runtime.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "apps", "web", "public", "models");

const MODELS = [
  {
    file: "ggml-tiny-q5_1.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q5_1.bin",
  },
  {
    file: "ggml-silero-v6.2.0.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
  },
];

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function download({ file, url }) {
  const target = join(outDir, file);
  const digestFile = `${target}.sha256`;

  if (existsSync(target) && existsSync(digestFile)) {
    const recorded = readFileSync(digestFile, "utf8").trim();
    if (sha256(readFileSync(target)) === recorded) {
      console.log(`models: ${file} already present`);
      return;
    }
    console.log(`models: ${file} is corrupt, re-downloading`);
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

  // Write to a temp name first so an interrupted run never leaves a truncated
  // file that looks valid to the next one.
  const temp = `${target}.partial`;
  writeFileSync(temp, bytes);
  renameSync(temp, target);
  writeFileSync(digestFile, sha256(bytes));
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
