#!/usr/bin/env node
/** 构建/运行前检查引擎模板是否完整（只查 index.html 会漏掉解压中断/半成品模板、以及旧的
 *  未回填 SE/主题的模板副本 —— 后者会让构建静默产出「无声效、无定制主题」的游戏，见 #779）。 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

let engineEntry = null;
if (!existsSync(assets) || !statSync(assets).isDirectory()) {
  problems.push("缺少 assets 目录");
} else {
  const entries = readdirSync(assets);
  engineEntry = entries.find((name) => /^index-.*\.js$/.test(name)) ?? null;
  if (entries.length === 0) problems.push("assets 目录为空");
  else if (!engineEntry) problems.push("assets 目录缺少引擎入口 index-*.js");
}

// 游戏定制主题（prepare:template 从 src/gameExtra/game-ui 回填；空模板 = 未回填）
const theme = join(TEMPLATE, "game", "userStyleSheet.css");
if (!existsSync(theme)) problems.push("缺少游戏主题 game/userStyleSheet.css");
else if (statSync(theme).size < 512) problems.push("游戏主题 game/userStyleSheet.css 为空模板（未回填）");

// 内置音效（prepare:template 从 src/gameExtra/se 回填；缺失时 playEffect 指向不存在的文件）
const seSrcDir = join(ROOT, "src", "gameExtra", "se");
const vocalDir = join(TEMPLATE, "game", "vocal");
if (existsSync(seSrcDir)) {
  const expected = readdirSync(seSrcDir).filter((name) => name.endsWith(".wav"));
  const actual = existsSync(vocalDir) ? new Set(readdirSync(vocalDir)) : new Set();
  const missing = expected.filter((name) => !actual.has(name));
  if (missing.length > 0) {
    problems.push(`game/vocal 缺少内置音效 ${missing.length}/${expected.length} 个（如 ${missing.slice(0, 3).join("、")}）`);
  }
}

// 配音中断定制（prepare:template 幂等应用；未应用时快进不打断语音）
if (engineEntry) {
  try {
    const text = readFileSync(join(assets, engineEntry), "utf8");
    if (text.includes("voiceInterruption:ud.no")) {
      problems.push("引擎入口仍为 voiceInterruption:ud.no（快进不打断语音，未应用定制）");
    }
  } catch {
    problems.push("引擎入口 index-*.js 读取失败");
  }
}

if (problems.length > 0) {
  console.error(
    `\n[NovelForge] WebGAL 引擎模板不完整或过于陈旧：${problems.join("；")}\n\n请先运行：\n\n  pnpm prepare:template\n\n（自动下载官方引擎包、裁剪并回填 SE/主题定制）\n`,
  );
  process.exit(1);
}
