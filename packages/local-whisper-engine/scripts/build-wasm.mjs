#!/usr/bin/env node
// Requires emsdk on PATH. Only needed when bumping the whisper.cpp submodule --
// the artifacts it produces are committed, so npm install/test never run this.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { EXPECTED_EMSCRIPTEN_VERSION, validateEmscriptenVersion } from "./emscripten-version.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const buildDir = join(packageRoot, "native", "build");
const outDir = join(packageRoot, "wasm");

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

const readEmccVersion = () => {
  try {
    return execFileSync("emcc", ["--version"], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`Unable to run \`emcc --version\`. Install Emscripten ${EXPECTED_EMSCRIPTEN_VERSION}.${detail}`);
  }
};

const resetBuildDirectory = () => {
  const resolvedNativeDir = realpathSync(join(packageRoot, "native"));
  const expectedBuildDir = join(resolvedNativeDir, "build");

  if (relative(resolvedNativeDir, expectedBuildDir) !== "build") {
    throw new Error(`Refusing to reset an unexpected WASM build directory: ${expectedBuildDir}`);
  }

  if (existsSync(buildDir)) {
    const resolvedBuildDir = realpathSync(buildDir);
    if (resolvedBuildDir !== expectedBuildDir) {
      throw new Error(`Refusing to reset a non-package-owned WASM build directory: ${resolvedBuildDir}`);
    }
    rmSync(buildDir, { recursive: true, force: true });
  }

  mkdirSync(buildDir, { recursive: true });
};

if (!existsSync(join(packageRoot, "..", "..", "vendor", "whisper.cpp", "CMakeLists.txt"))) {
  console.error("vendor/whisper.cpp is empty. Run: git submodule update --init --recursive");
  process.exit(1);
}

try {
  const emccVersion = validateEmscriptenVersion(readEmccVersion());
  console.log(`Using Emscripten ${emccVersion}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

resetBuildDirectory();
mkdirSync(outDir, { recursive: true });

run("emcmake", ["cmake", "..", "-DCMAKE_BUILD_TYPE=Release"], buildDir);
run("cmake", ["--build", ".", "--parallel"], buildDir);

for (const file of ["whisper-bridge.js", "whisper-bridge.wasm"]) {
  copyFileSync(join(buildDir, file), join(outDir, file));
  console.log(`wrote wasm/${file}`);
}
console.log("Commit the files in wasm/ -- they ship as build output.");
