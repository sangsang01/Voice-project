import { createHash } from "node:crypto";
import {
  existsSync as defaultExistsSync,
  mkdirSync as defaultMkdirSync,
  readFileSync as defaultReadFileSync,
  renameSync as defaultRenameSync,
  rmSync as defaultRmSync,
  writeFileSync as defaultWriteFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_MODELS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "models");

export const SERVER_MODELS = {
  base: {
    file: "ggml-base.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
  },
  small: {
    file: "ggml-small.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
  },
  medium: {
    file: "ggml-medium.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
    sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
  },
  vad: {
    file: "ggml-silero-v6.2.0.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
    sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
  },
};

const DEFAULT_FS = {
  existsSync: defaultExistsSync,
  mkdirSync: defaultMkdirSync,
  readFileSync: defaultReadFileSync,
  renameSync: defaultRenameSync,
  rmSync: defaultRmSync,
  writeFileSync: defaultWriteFileSync,
};

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function parseModelName(argv) {
  const args = argv ?? process.argv.slice(2);
  const flag = args.indexOf("--model");
  if (flag === -1) return "small";
  const value = args[flag + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--model requires a name");
  }
  return value;
}

function assertMultilingual(model) {
  if (model.includes(".en")) {
    throw new Error(`refusing English-only model "${model}": .en weights are not supported`);
  }
}

function resolveSpec(model, catalog) {
  const spec = catalog[model];
  if (!spec) {
    throw new Error(`unknown model "${model}"`);
  }
  return spec;
}

function partialPath(target) {
  return `${target}.partial`;
}

function removePartial(fs, target) {
  fs.rmSync(partialPath(target), { force: true });
}

async function downloadModel(spec, { modelsDir, fetchFn, fs }) {
  const target = join(modelsDir, spec.file);
  removePartial(fs, target);

  if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === spec.sha256) {
    return;
  }

  const response = await fetchFn(spec.url);
  if (!response.ok) {
    throw new Error(`failed to download ${spec.file}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`failed to download ${spec.file}: empty response`);
  }

  const actualHash = sha256(bytes);
  const temp = partialPath(target);
  try {
    fs.writeFileSync(temp, bytes);
    if (actualHash !== spec.sha256) {
      throw new Error(`checksum mismatch for ${spec.file}: expected ${spec.sha256}, got ${actualHash}`);
    }
    fs.renameSync(temp, target);
  } finally {
    removePartial(fs, target);
  }
}

export async function provisionServerModels(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const modelsDir = options.modelsDir ?? DEFAULT_MODELS_DIR;
  const catalog = options.catalog ?? SERVER_MODELS;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const fs = { ...DEFAULT_FS, ...options.fs };

  const model = parseModelName(argv);
  assertMultilingual(model);
  const requested = resolveSpec(model, catalog);

  fs.mkdirSync(modelsDir, { recursive: true });

  const pending = [requested];
  if (model !== "vad" && catalog.vad) {
    pending.push(catalog.vad);
  }

  const partials = pending.map((spec) => partialPath(join(modelsDir, spec.file)));
  try {
    for (const spec of pending) {
      await downloadModel(spec, { modelsDir, fetchFn, fs });
    }
  } catch (error) {
    for (const path of partials) {
      fs.rmSync(path, { force: true });
    }
    throw error;
  }
}

function isCli() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isCli()) {
  provisionServerModels()
    .then(() => {
      console.log("models: ready");
    })
    .catch((error) => {
      console.error(`\n${error instanceof Error ? error.message : String(error)}`);
      console.error("Model download failed. Re-run with: npm run fetch-models --workspace @voice/transcription-server");
      process.exit(1);
    });
}
