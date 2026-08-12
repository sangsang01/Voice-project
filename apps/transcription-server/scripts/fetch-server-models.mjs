#!/usr/bin/env node
/**
 * Downloads multilingual Whisper small|medium plus Silero VAD into
 * apps/transcription-server/models/ with pinned SHA-256 verification.
 *
 * Usage: node scripts/fetch-server-models.mjs --model small|medium
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { provisionModels } from "./modelProvisioning.lib.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(packageRoot, "models");
const manifestPath = join(packageRoot, "test", "fixtures", "manifest.json");

const MANIFEST = JSON.parse(readFileSync(manifestPath, "utf8"));

function parseArgs(argv) {
  let model;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--model") {
      model = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    }
  }
  return { model };
}

function usage() {
  console.error("Usage: node scripts/fetch-server-models.mjs --model small|medium");
  console.error("Downloads exactly one Whisper tier plus Silero VAD; never both tiers.");
}

async function main() {
  const { model } = parseArgs(process.argv.slice(2));
  if (model !== "small" && model !== "medium") {
    usage();
    process.exitCode = 1;
    return;
  }

  const whisper = MANIFEST.models[model];
  const silero = MANIFEST.models.silero;
  if (!whisper || !silero) {
    throw new Error("manifest is missing required model entries");
  }

  const results = await provisionModels({
    models: [whisper, silero],
    outDir,
  });

  for (const result of results) {
    const label = result.status === "cached" ? "already present" : "downloaded";
    console.log(`models: ${result.file} ${label}`);
  }
  console.log(`models: wrote under ${outDir}`);
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  console.error("Model download failed. Re-run with: npm run fetch-models --workspace @voice/transcription-server -- --model small");
  process.exitCode = 1;
});
