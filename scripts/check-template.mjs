#!/usr/bin/env node
/** 构建/运行前检查引擎模板是否存在 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const index = join(ROOT, "src-tauri", "templates", "webgal", "index.html");

if (!existsSync(index)) {
  console.error(
    "\n[NovelForge] 缺少 WebGAL 引擎模板。请先运行：\n\n  pnpm prepare:template\n\n（自动下载官方引擎包并裁剪，仅需一次）\n",
  );
  process.exit(1);
}
