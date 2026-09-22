#!/usr/bin/env node
/** 构建/运行前检查引擎模板是否完整（只查 index.html 会漏掉解压中断/半成品模板、以及旧的
 *  未回填 SE/主题的模板副本 —— 后者会让构建静默产出「无声效、无定制主题」的游戏，见 #779）。 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "src-tauri", "templates", "webgal");
const index = join(TEMPLATE, "index.html");
const assets = join(TEMPLATE, "assets");
const engineJson = join(TEMPLATE, "webgal-engine.json");

/**
 * 提取主题 CSS 里的 CSS Modules 编译哈希类名（#1127），形如 `._main_rdjpk_1`、`._fastSlPreview_rdjpk_59`。
 * 这类类名由引擎构建生成，WebGAL 升级后会整批变化 → 对应规则静默失效（无报错、无告警）。
 * 返回去重后的类名列表（不含前导点）。
 */
export function hashClassSelectorsOf(cssText) {
  const re = /\.(-?[A-Za-z_][\w-]*?_[A-Za-z0-9]{4,8}_\d+)\b/g;
  const out = new Set();
  let match;
  while ((match = re.exec(cssText)) !== null) out.add(match[1]);
  return [...out];
}

/** 引擎产物（assets/*.css + assets/*.js）中缺失的哈希类名 */
export function missingEngineClasses(classNames, engineText) {
  return classNames.filter((name) => !engineText.includes(name));
}

/** 读取模板 assets 下的 css/js 产物文本（哈希选择器的存在性依据） */
function readEngineCorpus(assetsDir) {
  if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory()) return "";
  const chunks = [];
  for (const name of readdirSync(assetsDir)) {
    if (!/\.(css|js)$/i.test(name)) continue;
    try {
      chunks.push(readFileSync(join(assetsDir, name), "utf8"));
    } catch {
      /* 读取失败按缺失处理（后续 warning 会体现） */
    }
  }
  return chunks.join("\n");
}

function main() {
  const problems = [];
  const warnings = [];
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

  // #1127：主题里的 CSS Modules 哈希类名必须仍存在于引擎产物中。
  // 警告不阻断构建，但必须可见（引擎升级导致主题局部失效时，人在看构建日志即可发现）。
  if (existsSync(theme) && engineEntry) {
    const css = readFileSync(theme, "utf8");
    const selectors = hashClassSelectorsOf(css);
    if (selectors.length > 0) {
      const missing = missingEngineClasses(selectors, readEngineCorpus(assets));
      if (missing.length > 0) {
        warnings.push(
          `主题 userStyleSheet.css 有 ${missing.length}/${selectors.length} 条哈希选择器在引擎产物中不存在` +
            `（如 ${missing.slice(0, 5).map((n) => `.${n}`).join("、")}）——引擎升级后这些规则会静默失效`,
        );
      }
    }
  }

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

  if (warnings.length > 0) {
    console.warn(
      `\n[NovelForge] 主题校验警告（不阻断构建）：\n- ${warnings.join("\n- ")}\n\n` +
        `建议：把受影响的哈希选择器改用 CSS 变量或官方稳定锚点（title-enter / TextBox_* 等），\n` +
        `或运行 pnpm prepare:template 重新回填定制主题。\n`,
    );
  }

  if (problems.length > 0) {
    console.error(
      `\n[NovelForge] WebGAL 引擎模板不完整或过于陈旧：${problems.join("；")}\n\n请先运行：\n\n  pnpm prepare:template\n\n（自动下载官方引擎包、裁剪并回填 SE/主题定制）\n`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
