/**
 * 阶段测试器：把 src/core/* 核心模块功能剥离为无头可跑副本，
 * 从 %APPDATA%\com.novelforge.app\config.json 直接读 4 通道配置（不打印 key），
 * 用 demo 小说作输入，按阶段逐个真跑并判读 PASS/FAIL。
 *
 * 用法：npx tsx tests/stage-runner.ts [stage]
 *   stage ∈ split | translate | extract | script | image | assemble | all | baseline
 *   all = 1..6 连跑（TTS 跳过）
 *   baseline = ①..④ 文本四阶段（默认）
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEMO_NOVEL } from "../src/core/demoNovel";
import { aiSplitChapters } from "../src/core/split";
import { translateChapter } from "../src/core/translate";
import { extractFromNovel } from "../src/core/extract";
import { scriptChapter } from "../src/core/script";
import { renderChapter } from "../src/core/render";
import { setLlmConcurrency } from "../src/api/openaiCompatible";
import { concurrencyFor } from "../src/stores/configMigration";
import { tauri } from "../src/utils/tauri";
import type { ApiConfig, PipelineEvent } from "../src/core/types";

const CONFIG_PATH = `${process.env.APPDATA}/com.novelforge.app/config.json`;
const TARGET_LANG = "en";

interface LoadedConfig {
  llm?: ApiConfig;
  vision?: ApiConfig;
  image?: ApiConfig;
  tts?: ApiConfig;
}

function loadConfig(): LoadedConfig {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const parsed = JSON.parse(raw) as { presets: Array<{ active: Record<string, string>; channels: Record<string, ApiConfig[]> }> };
  const preset = parsed.presets[0];
  const out: LoadedConfig = {};
  const activeMap = preset.active ?? {};
  for (const kind of ["llm", "vision", "image", "tts"] as const) {
    const list = preset.channels[kind] ?? [];
    const activeId = activeMap[kind];
    const cfg = list.find((c) => c.id === activeId) ?? list[0];
    if (cfg) out[kind] = cfg;
  }
  return out;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`✗ ${message}`);
}

function ok(message: string): void {
  console.log(`✓ ${message}`);
}

function summary(label: string, info: Record<string, unknown>): void {
  console.log(`  ${label}:`, info);
}

async function stage1Split(llm: ApiConfig): Promise<void> {
  console.log("\n[① 分章] aiSplitChapters");
  setLlmConcurrency(llm, concurrencyFor(llm, "llm"));
  const t0 = Date.now();
  const chapters = await aiSplitChapters(llm, DEMO_NOVEL, undefined, 40000, undefined, concurrencyFor(llm, "llm"));
  const ms = Date.now() - t0;
  assert(Array.isArray(chapters) && chapters.length >= 2, `章节数≥2（实际 ${chapters?.length}）`);
  for (const [i, c] of chapters.entries()) {
    assert(typeof c.title === "string" && c.title.length > 0, `ch[${i}].title 非空`);
    assert(typeof c.text === "string" && c.text.length > 0, `ch[${i}].text 非空`);
    assert(c.charCount > 0, `ch[${i}].charCount > 0`);
  }
  ok(`PASS ${chapters.length} 章, 用时 ${ms}ms`);
  summary("chapters", chapters.map((c) => `${c.index + 1}:${c.title}(${c.charCount}字)`));
  // 写到磁盘供后续阶段复用
  const out = await import("node:fs/promises");
  const path = resolve(process.cwd(), "tests/.tmp-stage-runner/split.json");
  await out.mkdir(resolve(process.cwd(), "tests/.tmp-stage-runner"), { recursive: true });
  await out.writeFile(path, JSON.stringify(chapters, null, 2), "utf-8");
}

async function stage2Translate(llm: ApiConfig): Promise<void> {
  console.log("\n[② 翻译] translateChapter→英文");
  setLlmConcurrency(llm, concurrencyFor(llm, "llm"));
  const chapters = await loadChapters();
  assert(chapters.length > 0, "无章节缓存（请先跑 ① 分章）");
  const t0 = Date.now();
  const first = chapters[0];
  const tr = await translateChapter(llm, first, TARGET_LANG);
  const ms = Date.now() - t0;
  assert(typeof tr.title === "string" && tr.title.length > 0, "译文 title 非空");
  assert(typeof tr.text === "string" && tr.text.length > 0, "译文 text 非空");
  // 翻译检验：与原文字符差异显著（粗略判定确实翻译了）
  const sameChars = countSameConsecutiveChars(first.text, tr.text);
  assert(tr.text.length > 0, "译文长度 > 0");
  const ratio = sameChars / Math.max(tr.text.length, 1);
  assert(ratio < 0.5 || tr.text.length < 100, `译文与原文相似度 ${(ratio * 100).toFixed(1)}%（过高=可能未翻译）`);
  ok(`PASS ch1 翻译: "${tr.title.slice(0, 60)}" 用时 ${ms}ms 长度 ${tr.text.length}`);
}

function countSameConsecutiveChars(a: string, b: string): number {
  let n = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] === b[i]) n++;
  }
  return n;
}

async function loadChapters(): Promise<import("../src/core/types").ChapterInfo[]> {
  const path = resolve(process.cwd(), "tests/.tmp-stage-runner/split.json");
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as import("../src/core/types").ChapterInfo[];
}

async function stage3Extract(llm: ApiConfig): Promise<void> {
  console.log("\n[③ 提取] extractFromNovel");
  setLlmConcurrency(llm, concurrencyFor(llm, "llm"));
  const t0 = Date.now();
  const cards = await extractFromNovel(llm, DEMO_NOVEL, "星陨之城的守夜人");
  const ms = Date.now() - t0;
  assert(Array.isArray(cards.characters) && cards.characters.length >= 2, `角色≥2（实际 ${cards.characters?.length}）`);
  assert(Array.isArray(cards.scenes) && cards.scenes.length >= 1, `场景≥1（实际 ${cards.scenes?.length}）`);
  assert(Array.isArray(cards.items), "items 是数组");
  assert(typeof cards.title === "string" && cards.title.length > 0, "title 非空");
  for (const [i, c] of cards.characters.entries()) {
    assert(c.id && c.name && c.imagePrompt && c.threeViewPrompt, `角色 ${i} 字段完整（id/name/imagePrompt/threeViewPrompt）`);
    assert(typeof c.voiceName === "string", `角色 ${i}.voiceName 已分配（=${c.voiceName}）`);
  }
  for (const [i, s] of cards.scenes.entries()) {
    assert(s.id && s.location, `场景 ${i} 字段完整（id/location）`);
  }
  ok(`PASS ${cards.characters.length}角色/${cards.scenes.length}场景/${cards.items.length}物品, 用时 ${ms}ms`);
  const out = await import("node:fs/promises");
  const path = resolve(process.cwd(), "tests/.tmp-stage-runner/cards.json");
  await out.writeFile(path, JSON.stringify(cards, null, 2), "utf-8");
}

async function stage4Script(llm: ApiConfig): Promise<void> {
  console.log("\n[④ 剧本] scriptChapter 每章 + render 校验");
  setLlmConcurrency(llm, concurrencyFor(llm, "llm"));
  const chapters = await loadChapters();
  const cardsRaw = readFileSync(resolve(process.cwd(), "tests/.tmp-stage-runner/cards.json"), "utf-8");
  const cards = JSON.parse(cardsRaw) as import("../src/core/types").ExtractionResult;
  const t0 = Date.now();
  // 只跑第 1 章以控时
  const first = chapters[0];
  const script = await scriptChapter(llm, first, cards);
  const ms = Date.now() - t0;
  assert(Array.isArray(script.scenes) && script.scenes.length >= 1, `scenes≥1（实际 ${script.scenes?.length}）`);
  const totalLines = script.scenes.reduce((n, s) => n + s.lines.length, 0);
  assert(totalLines >= 1, `lines≥1（实际 ${totalLines}）`);
  // 场景 id 去重
  const ids = script.scenes.map((s) => s.id);
  assert(new Set(ids).size === ids.length, "场景 id 无重复");
  // render 语法校验
  const txt = renderChapter(script, {
    title: cards.title,
    gameKey: "test",
    characters: cards.characters,
    items: cards.items,
    assets: { bg: {}, cg: {}, figure: {}, item: {}, vocal: {} },
  }, 1);
  assert(/end;$/.test(txt.trim().split("\n").filter((l) => l.trim()).pop() ?? ""), "剧本以 end; 结尾");
  ok(`PASS ch1 剧本 ${script.scenes.length}场/${totalLines}句, 用时 ${ms}ms`);
  const out = await import("node:fs/promises");
  const path = resolve(process.cwd(), "tests/.tmp-stage-runner/script-ch1.json");
  await out.writeFile(path, JSON.stringify(script, null, 2), "utf-8");
}

async function stage5Image(cfg: { llm: ApiConfig; vision?: ApiConfig; image: ApiConfig }): Promise<void> {
  console.log("\n[⑤ 图像] generateImages + Rust cutout");
  if (!cfg.image?.apiKey) throw new Error("image apiKey 未配置");
  const chaptersRaw = readFileSync(resolve(process.cwd(), "tests/.tmp-stage-runner/script-ch1.json"), "utf-8");
  const script = JSON.parse(chaptersRaw) as import("../src/core/types").ChapterScript;
  const cardsRaw = readFileSync(resolve(process.cwd(), "tests/.tmp-stage-runner/cards.json"), "utf-8");
  const cards = JSON.parse(cardsRaw) as import("../src/core/types").ExtractionResult;
  const cacheRoot = resolve(process.cwd(), "tests/.tmp-stage-runner/cache").replace(/\\/g, "/");
  const fs = await import("node:fs/promises");
  await fs.rm(cacheRoot, { recursive: true, force: true });

  const log = (ev: PipelineEvent): void => {
    if (ev.level === "error" || ev.level === "warn") {
      console.log(`  [${ev.level}] ${ev.step}: ${ev.message}`);
    } else if (ev.level === "success" || (typeof ev.message === "string" && ev.message.startsWith("进度"))) {
      console.log(`  ${ev.message}`);
    }
  };

  const t0 = Date.now();
  const { images, failed } = await import("../src/core/images").then((m) =>
    m.generateImages(
      cfg.image,
      [script],
      cards,
      [],
      cacheRoot,
      log as never,
      1, // concurrency
      true, // figureEmotions
      undefined,
      undefined,
      false, // force
      true, // threeView
      false, // withActions (跳过动作立绘)
      undefined,
      undefined,
      true, // styleAnchor
      undefined,
      undefined,
      cfg.vision,
    ),
  );
  const ms = Date.now() - t0;

  const figCount = Object.keys(images.figure).length;
  const bgCount = Object.keys(images.bg).length;
  const itemCount = Object.keys(images.item).length;
  assert(figCount > 0, `figure 任务完成数>0（实际 ${figCount}）`);
  assert(bgCount > 0, `background 任务完成数>0（实际 ${bgCount}）`);
  assert(failed.length === 0, `失败任务=0（实际 ${failed.length}：${failed.map((f) => f.message).slice(0, 3).join(" | ")})`);
  ok(`PASS 生成 ${figCount} figure / ${bgCount} bg / ${itemCount} item, 失败 ${failed.length}, 用时 ${ms}ms`);

  // 抠图验证：Node 环境 tauri.cutoutImage 是 no-op（ensureCutout 因 hasTransparency=true 跳过）
  // 用真实 Rust cutout_stats 对每张 figure/action/item 跑一遍，统计 alpha
  const figures = Object.entries(images.figure);
  console.log(`  → 用 Rust cutout_stats 对 ${figures.length} 张图抠图+统计 alpha`);
  const exe = resolve(process.cwd(), "src-tauri/target/release/examples/cutout_stats.exe");
  const statResults: Array<{ key: string; stats: Record<string, unknown> }> = [];
  for (const [key, filePath] of figures) {
    if (!filePath) continue;
    const r = await runCutoutStats(exe, filePath);
    if (r?.stats) statResults.push({ key, stats: r.stats });
  }
  if (statResults.length === 0) throw new Error("无图可抠");

  // 汇总判定
  const summaries = statResults.map((r) => ({
    key: r.key,
    corner0: Array.isArray(r.stats.corner_alpha) ? (r.stats.corner_alpha as number[])[0] : -1,
    darkCount: typeof r.stats.dark_pixel_count === "number" ? r.stats.dark_pixel_count : 0,
    darkAlpha255: typeof r.stats.dark_pixel_alpha255_count === "number" ? r.stats.dark_pixel_alpha255_count : 0,
    err: typeof r.stats.error === "string" ? r.stats.error : "",
  }));
  console.log("  抠图统计:");
  for (const s of summaries) console.log(`    ${s.key}: 角alpha=${s.corner0} 前景暗像素=${s.darkCount} 完全不透明暗像素=${s.darkAlpha255}${s.err ? "  ERR=" + s.err : ""}`);

  // 抠图基本通过：能抠的图四角 alpha = 0（bg 抠掉）；cutout 报错的图（退化图）跳过不算 fail
  const validResults = summaries.filter((s) => s.corner0 === 0);
  const cutoutFailed = summaries.filter((s) => s.err.length > 0);
  assert(validResults.length > 0, `无一张图抠图成功（${summaries.length} 张全部 cutout 失败）`);
  ok(`✓ 抠图基本通过：${validResults.length}/${summaries.length} 张图四角均透明${cutoutFailed.length > 0 ? `（${cutoutFailed.length} 张退化图跳过）` : ""}`);

  // 暗色前景保护：黑发/黑衣应保留为不透明前景
  // 判据：含前景暗像素的图（darkCount > 1000），必须存在完全不透明（alpha=255）的暗像素。
  // 这证明黑发/黑衣的最深处被保留为完全不透明前景，未被羽化成半透明。
  const darkFigures = summaries.filter((s) => s.darkCount > 1000 && !s.err);
  let bugHits = 0;
  if (darkFigures.length > 0) {
    for (const s of summaries) {
      if (s.darkCount <= 1000 || s.err) continue;
      if (s.darkAlpha255 < 100) {
        console.log(`    BUG: ${s.key} darkCount=${s.darkCount} 但完全不透明暗像素仅 ${s.darkAlpha255}（应≥100 = 黑发/黑衣最深处）`);
        bugHits++;
      }
    }
    if (bugHits > 0) {
      throw new Error(`BUG 复现：${bugHits} 张图绿底把黑色抠成灰色半透明（暗色前景保护失效）`);
    }
    ok(`✓ 暗色前景保护：${darkFigures.length} 张含前景暗像素图均保留完全不透明黑像素（≥100）`);
  } else {
    console.log(`  （无图含前景暗像素，跳过 bug 判定）`);
  }
}

async function runCutoutStats(exe: string, filePath: string): Promise<{ stats: Record<string, unknown> } | null> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolveP) => {
    const proc = spawn(exe, [filePath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("close", () => {
      try {
        const lastLine = out.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop();
        if (!lastLine) {
          console.log(`    [cutout_stats 无输出] stderr=${err.slice(0, 200)}`);
          resolveP(null);
          return;
        }
        const parsed = JSON.parse(lastLine) as { stats: Record<string, unknown> };
        resolveP(parsed);
      } catch (e) {
        console.log(`    [cutout_stats 解析失败] ${e instanceof Error ? e.message : String(e)}`);
        resolveP(null);
      }
    });
  });
}

async function stage5Recutout(): Promise<void> {
  console.log("\n[⑤.重抠图] Rust cutout_stats 对已生成缓存批量抠图");
  const exe = resolve(process.cwd(), "src-tauri/target/release/examples/cutout_stats.exe");
  const cacheImgDir = resolve(process.cwd(), "tests/.tmp-stage-runner/cache/images");
  const fs = await import("node:fs/promises");
  const entries = await fs.readdir(cacheImgDir);
  const pngs = entries.filter((n) => n.endsWith(".png") && !n.endsWith(".out.png"));
  if (pngs.length === 0) throw new Error("缓存目录无 PNG（请先跑 image 阶段）");
  console.log(`  发现 ${pngs.length} 张缓存 PNG，逐张调用 Rust cutout_stats`);
  const statResults: Array<{ key: string; stats: Record<string, unknown> }> = [];
  for (const name of pngs) {
    const filePath = `${cacheImgDir}/${name}`;
    const r = await runCutoutStats(exe, filePath);
    if (r?.stats) statResults.push({ key: name, stats: r.stats });
  }

  const summaries = statResults.map((r) => ({
    key: r.key,
    corner0: Array.isArray(r.stats.corner_alpha) ? (r.stats.corner_alpha as number[])[0] : -1,
    darkCount: typeof r.stats.dark_pixel_count === "number" ? r.stats.dark_pixel_count : 0,
    darkAlpha255: typeof r.stats.dark_pixel_alpha255_count === "number" ? r.stats.dark_pixel_alpha255_count : 0,
    err: typeof r.stats.error === "string" ? r.stats.error : "",
  }));
  const validResults = summaries.filter((s) => s.corner0 === 0);
  const cutoutFailed = summaries.filter((s) => s.err.length > 0);
  ok(`✓ 抠图基本通过：${validResults.length}/${summaries.length} 张图四角均透明${cutoutFailed.length > 0 ? `（${cutoutFailed.length} 张退化图跳过）` : ""}`);

  // 暗色前景保护
  const darkFigures = summaries.filter((s) => s.darkCount > 1000 && !s.err);
  let bugHits = 0;
  if (darkFigures.length > 0) {
    for (const s of summaries) {
      if (s.darkCount <= 1000 || s.err) continue;
      if (s.darkAlpha255 < 100) {
        console.log(`    BUG: ${s.key} darkCount=${s.darkCount} 但完全不透明暗像素仅 ${s.darkAlpha255}`);
        bugHits++;
      }
    }
    if (bugHits > 0) {
      throw new Error(`BUG 复现：${bugHits} 张图绿底把黑色抠成灰色半透明（暗色前景保护失效）`);
    }
    ok(`✓ 暗色前景保护：${darkFigures.length} 张含前景暗像素图均保留完全不透明黑像素`);
  }
}

async function stage6Assemble(): Promise<void> {
  console.log("\n[⑥ 组装] assembleProject + lint + engine-check 试玩");
  const fs = await import("node:fs/promises");
  const scriptRaw = readFileSync(resolve(process.cwd(), "tests/.tmp-stage-runner/script-ch1.json"), "utf-8");
  const script = JSON.parse(scriptRaw) as import("../src/core/types").ChapterScript;
  const cardsRaw = readFileSync(resolve(process.cwd(), "tests/.tmp-stage-runner/cards.json"), "utf-8");
  const cards = JSON.parse(cardsRaw) as import("../src/core/types").ExtractionResult;
  // 读取缓存中的图像作为 assets
  const cacheImgDir = resolve(process.cwd(), "tests/.tmp-stage-runner/cache/images");
  const allNames = (await fs.readdir(cacheImgDir)).filter((n) => n.endsWith(".png"));
  const assets = { bg: {} as Record<string, string>, cg: {} as Record<string, string>, figure: {} as Record<string, string>, item: {} as Record<string, string>, vocal: {} as Record<string, string>, bgm: {} as Record<string, string> };
  // 优先 .out.png（已抠图），退回 .png（未抠图：背景/CG 不抠图）
  const byBase = new Map<string, string>();
  for (const n of allNames) {
    const base = n.replace(/\.out\.png$/, ".png");
    if (!byBase.has(base) || n.endsWith(".out.png")) byBase.set(base, n);
  }
  for (const [base, actualName] of byBase) {
    const filePath = `${cacheImgDir}/${actualName}`.replace(/\\/g, "/");
    const m = /^(bg|cg|figure|item|threeview|anchor)_(.+)\.png$/.exec(base);
    if (!m) continue;
    const kind = m[1];
    const id = m[2].replace(/_normal$/, "");
    if (kind === "bg") assets.bg[id] = filePath;
    else if (kind === "cg") assets.cg[id] = filePath;
    else if (kind === "figure" || kind === "threeview" || kind === "anchor") assets.figure[id] = filePath;
    else if (kind === "item") assets.item[id] = filePath;
  }

  const outputDir = resolve(process.cwd(), "tests/.tmp-stage-runner/output").replace(/\\/g, "/");
  await fs.rm(outputDir, { recursive: true, force: true });
  const templateDir = resolve(process.cwd(), "src-tauri/templates/webgal").replace(/\\/g, "/");

  const { assembleProject } = await import("../src/core/project");
  const t0 = Date.now();
  const r = await assembleProject({
    outputDir,
    title: cards.title,
    gameKey: "starfall-night-watch",
    templateDir,
    chapters: [script],
    cards,
    assets,
    log: (m) => console.log(`  ${m}`),
  });
  const ms = Date.now() - t0;

  // 验证输出
  const indexOk = await fs.access(`${outputDir}/index.html`).then(() => true).catch(() => false);
  const configOk = await fs.access(`${outputDir}/game/config.txt`).then(() => true).catch(() => false);
  const sceneOk = await fs.access(`${outputDir}/game/scene`).then(() => true).catch(() => false);
  assert(indexOk, "组装产物 index.html 缺失");
  assert(configOk, "组装产物 game/config.txt 缺失");
  assert(sceneOk, "组装产物 game/scene 目录缺失");
  const sceneFiles = await fs.readdir(`${outputDir}/game/scene`);
  assert(sceneFiles.some((f) => f.endsWith(".txt")), `scene 目录有 .txt 剧本（${sceneFiles.join(", ")}）`);

  ok(`PASS 组装完成：${ms}ms，meta=${JSON.stringify(r.meta)}, scene 文件 ${sceneFiles.length} 个`);
  summary("assets", {
    bg: Object.keys(assets.bg).length,
    cg: Object.keys(assets.cg).length,
    figure: Object.keys(assets.figure).length,
    item: Object.keys(assets.item).length,
  });

  // lint 检查
  const { lintProject } = await import("../src/core/lint");
  const lintReport = await lintProject(outputDir);
  console.log(`  lint: ${lintReport.errors.length} 错误 / ${lintReport.warnings.length} 警告`);
  if (lintReport.errors.length > 0) {
    for (const e of lintReport.errors.slice(0, 5)) console.log(`    [error] ${e.message}`);
  }
  ok(`✓ lint 完成`);

  // 引擎试玩：用 playwright 启动 headless browser 加载 WebGAL index.html，验证能播放 ch1
  const { spawn: spawnChild } = await import("node:child_process");
  const playwrightExe = resolve(process.cwd(), "node_modules/playwright/cli.js");
  const engineScript = resolve(process.cwd(), "tests/engine-check.ts");
  if (!await fs.access(playwrightExe).then(() => true).catch(() => false)) {
    console.log("  ⚠ playwright cli 未找到，跳过 engine-check 试玩");
    return;
  }
  const t1 = Date.now();
  const proc = spawnChild(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", engineScript, outputDir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let pout = "";
  let perr = "";
  proc.stdout?.on("data", (d: Buffer) => (pout += d.toString()));
  proc.stderr?.on("data", (d: Buffer) => (perr += d.toString()));
  const exitCode: number = await new Promise((res) => proc.on("close", (c: number | null) => res(c ?? -1)));
  const eMs = Date.now() - t1;
  console.log(`  engine-check: ${eMs}ms exit=${exitCode}`);
  const tail = (pout + perr).trim().split("\n").slice(-10).join("\n");
  console.log(`  engine-check tail:\n${tail.split("\n").map((l) => "    " + l).join("\n")}`);
  if (exitCode !== 0) throw new Error(`engine-check 失败：exit=${exitCode}`);
  ok(`✓ 引擎试玩通过（headless playwright 加载 ch1）`);
}

async function main(): Promise<void> {
  const stageArg = process.argv[2] ?? "baseline";
  console.log(`[stage-runner] mode=${stageArg} config=${CONFIG_PATH}`);
  // 静默 tauri 日志噪音
  try { (tauri as unknown as Record<string, unknown>).log = undefined; } catch {}

  const cfg = loadConfig();
  if (!cfg.llm?.apiKey) {
    console.error("✗ LLM 未配置（config.json 缺少 llm apiKey）");
    process.exit(1);
  }
  summary("channels", {
    llm: `${cfg.llm?.baseUrl} / ${cfg.llm?.model}`,
    vision: cfg.vision ? `${cfg.vision.baseUrl} / ${cfg.vision.model}` : "(无)",
    image: cfg.image ? `${cfg.image.baseUrl} / ${cfg.image.model}` : "(无)",
    tts: cfg.tts ? `${cfg.tts.baseUrl} / ${cfg.tts.model}` : "(无)",
  });

  const runSet = new Set<string>(stageArg === "all" ? ["split", "translate", "extract", "script", "image", "recutout", "assemble"]
    : stageArg === "baseline" ? ["split", "translate", "extract", "script"]
    : [stageArg]);

  const fails: string[] = [];
  for (const s of runSet) {
    try {
      if (s === "split") await stage1Split(cfg.llm!);
      else if (s === "translate") await stage2Translate(cfg.llm!);
      else if (s === "extract") await stage3Extract(cfg.llm!);
      else if (s === "script") await stage4Script(cfg.llm!);
      else if (s === "image") {
        if (!cfg.image) throw new Error("image apiKey 未配置");
        await stage5Image({ llm: cfg.llm!, vision: cfg.vision, image: cfg.image });
      }
      else if (s === "recutout") await stage5Recutout();
      else if (s === "assemble") await stage6Assemble();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`✗ [${s}] ${msg}`);
      fails.push(`${s}: ${msg}`);
    }
  }

  console.log(`\n=== stage-runner done: ${runSet.size - fails.length}/${runSet.size} pass ===`);
  if (fails.length) {
    console.error("FAILED stages:", fails);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("stage-runner fatal:", e);
  process.exit(1);
});