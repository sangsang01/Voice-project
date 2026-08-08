#!/usr/bin/env node
// Requires emsdk on PATH. Only needed when bumping the whisper.cpp submodule --
// the artifacts it produces are committed, so npm install/test never run this.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const buildDir = join(packageRoot, "native", "build");
const outDir = join(packageRoot, "wasm");

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

if (!existsSync(join(packageRoot, "..", "..", "vendor", "whisper.cpp", "CMakeLists.txt"))) {
  console.error("vendor/whisper.cpp is empty. Run: git submodule update --init --recursive");
  process.exit(1);
}

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

run("emcmake", ["cmake", "..", "-DCMAKE_BUILD_TYPE=Release"], buildDir);
run("cmake", ["--build", ".", "--parallel"], buildDir);

for (const file of ["whisper-bridge.js", "whisper-bridge.wasm"]) {
  copyFileSync(join(buildDir, file), join(outDir, file));
  console.log(`wrote wasm/${file}`);
}
console.log("Commit the files in wasm/ -- they ship as build output.");
