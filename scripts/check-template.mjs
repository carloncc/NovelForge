#!/usr/bin/env node
/** 构建/运行前检查引擎模板是否完整（只查 index.html 会漏掉解压中断/半成品模板） */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "src-tauri", "templates", "webgal");
const index = join(TEMPLATE, "index.html");
const assets = join(TEMPLATE, "assets");
const engineJson = join(TEMPLATE, "webgal-engine.json");

const problems = [];
if (!existsSync(index)) problems.push("缺少 index.html");
if (!existsSync(engineJson)) problems.push("缺少 webgal-engine.json");
if (!existsSync(assets) || !statSync(assets).isDirectory()) {
  problems.push("缺少 assets 目录");
} else {
  const entries = readdirSync(assets);
  const hasEngineBundle = entries.some((name) => /^index-.*\.js$/.test(name));
  if (entries.length === 0) problems.push("assets 目录为空");
  else if (!hasEngineBundle) problems.push("assets 目录缺少引擎入口 index-*.js");
}

if (problems.length > 0) {
  console.error(
    `\n[NovelForge] WebGAL 引擎模板不完整：${problems.join("；")}\n\n请先运行：\n\n  pnpm prepare:template\n\n（自动下载官方引擎包并裁剪，仅需一次）\n`,
  );
  process.exit(1);
}
