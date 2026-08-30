/**
 * 复制 onnxruntime-web 的 WASM 运行时文件到 public/onnx（移植自「抠图」项目 scripts/copy-runtime-assets.mjs）。
 * 前端 CutoutRuntime 通过 ort.env.wasm.wasmPaths = "/onnx/" 加载。
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const onnxSource = resolve(projectRoot, "node_modules/onnxruntime-web/dist");
const onnxDestination = resolve(projectRoot, "public/onnx");
const runtimeFiles = [
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  // WebGPU 执行器初始化会动态 import asyncify 模块，缺失会导致 initWasm 失败
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
];

if (!existsSync(onnxSource)) {
  console.warn("[copy-ort] onnxruntime-web 未安装；已跳过 WASM 运行时复制。");
  process.exit(0);
}

mkdirSync(onnxDestination, { recursive: true });
const copied = [];
for (const filename of runtimeFiles) {
  const source = resolve(onnxSource, filename);
  if (existsSync(source)) {
    copyFileSync(source, resolve(onnxDestination, filename));
    copied.push(filename);
  } else {
    console.warn(`[copy-ort] 跳过缺失文件：${filename}`);
  }
}
console.log(`[copy-ort] 已复制 ${copied.length}/${runtimeFiles.length} 个文件到 public/onnx`);
if (copied.length < runtimeFiles.length) {
  console.warn(`[copy-ort] 缺失：${runtimeFiles.filter((name) => !copied.includes(name)).join(", ")}`);
}
