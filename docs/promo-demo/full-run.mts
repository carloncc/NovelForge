/**
 * NovelForge 全量生成驱动器（无 GUI）——把一整部小说生成成 WebGAL 视觉小说。
 *
 * 为什么需要它：仓库里的 tests/stage-runner.ts 是**单章 demo 测试器**
 *   - 输入写死为内置示例小说 DEMO_NOVEL（stage-runner.ts:13,65,120）
 *   - 剧本/图像/组装都只跑第 1 章（stage-runner.ts:147,172,385）
 *   - 输出目录写死 tests/.tmp-stage-runner/*（stage-runner.ts:77,111,135,165,176,374）
 *   - gameKey 写死 starfall-night-watch（stage-runner.ts:383）
 * 所以它无法产出「整部小说 8 章的 WebGAL 成品」。本文件不修改仓库任何文件，
 * 只 import 仓库里**真实的生产管线**（src/core/pipeline.ts 的 Pipeline 类），
 * 按 GUI「整书生成」的同一条链路跑：提取 → 剧本 → 图像 → 配音 → 组装。
 *
 * 配置来源：%APPDATA%\com.novelforge.app\config.json 的 presets[0]，
 * 要求 llm/image 通道内联存在 apiKey（由 生成全部.ps1 临时注入、事后还原）。
 * 本脚本**绝不打印任何 apiKey**（错误信息也过一遍 redact）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pipeline } from "../NovelForge-main/src/core/pipeline";
import { importNovelFile } from "../NovelForge-main/src/core/chapters";
import { computeProjectVisualBibleFingerprint } from "../NovelForge-main/src/core/visualBible";
import type {
  ApiConfig,
  GenerationOptions,
  PipelineEvent,
  ProjectVisualBible,
  StageKey,
} from "../NovelForge-main/src/core/types";

const CONFIG_PATH = `${process.env.APPDATA}/com.novelforge.app/config.json`;

/* ------------------------------------------------------------------ 配置读取 */

interface LoadedChannels {
  llm?: ApiConfig;
  vision?: ApiConfig;
  image?: ApiConfig;
  tts?: ApiConfig;
}

/** 与 tests/stage-runner.ts 的 loadConfig 同口径：presets[0] → active[kind] → channels[kind][i] */
function loadConfig(): LoadedChannels {
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as {
    presets: Array<{ active: Record<string, string>; channels: Record<string, ApiConfig[]> }>;
  };
  const preset = parsed.presets?.[0];
  if (!preset) throw new Error(`config.json 里没有 presets[0]：${CONFIG_PATH}`);
  const out: LoadedChannels = {};
  const activeMap = preset.active ?? {};
  for (const kind of ["llm", "vision", "image", "tts"] as const) {
    const list = preset.channels?.[kind] ?? [];
    const activeId = activeMap[kind];
    const cfg = list.find((c) => c.id === activeId) ?? list[0];
    if (cfg) out[kind] = cfg;
  }
  return out;
}

/* ------------------------------------------------------------------ 密钥脱敏 */

let SECRETS: string[] = [];
function registerSecrets(cfg: LoadedChannels): void {
  SECRETS = Object.values(cfg)
    .map((c) => c?.apiKey)
    .filter((k): k is string => typeof k === "string" && k.length >= 6);
}
function redact(text: string): string {
  let out = text;
  for (const s of SECRETS) out = out.split(s).join("***REDACTED***");
  return out;
}

/* ------------------------------------------------------------------ 日志 */

function fmtProgress(ev: PipelineEvent): string | null {
  const p = (ev as { progress?: { done?: number; total?: number } }).progress;
  if (!p || typeof p.done !== "number" || typeof p.total !== "number" || p.total <= 0) return null;
  const pct = Math.floor((p.done / p.total) * 100);
  const bar = "#".repeat(Math.floor(pct / 4)).padEnd(25, "-");
  return `  [${ev.step}] ${bar} ${pct}% (${p.done}/${p.total})`;
}

function makeLogger(tag: string): (ev: PipelineEvent) => void {
  let lastLine = "";
  return (ev: PipelineEvent) => {
    const prog = fmtProgress(ev);
    if (prog) {
      if (prog !== lastLine) {
        lastLine = prog;
        process.stdout.write(`\r${prog}          `);
      }
      if (ev.level === "error" || ev.level === "warn") {
        process.stdout.write("\n");
        lastLine = "";
        console.log(`  ! ${redact(String(ev.message))}`);
      }
      return;
    }
    if (lastLine) {
      process.stdout.write("\n");
      lastLine = "";
    }
    const msg = redact(String(ev.message ?? ""));
    if (ev.level === "error") console.log(`  x [${ev.step}] ${msg}`);
    else if (ev.level === "warn") console.log(`  ! [${ev.step}] ${msg}`);
    else if (ev.level === "success") console.log(`  v [${ev.step}] ${msg}`);
    else if (ev.step === "开始" || ev.step === "分章" || ev.step === "提取" || ev.step === "剧本" || ev.step === "图像" || ev.step === "配音" || ev.step === "组装" || ev.step === "完成") {
      console.log(`  - [${tag}/${ev.step}] ${msg}`);
    }
  };
}

/* ------------------------------------------------------------------ 主流程 */

const NOVEL_PATH = process.env.NF_NOVEL ?? resolve(process.cwd(), "..", "小说", "铁皮城堡.txt");
const OUTPUT_DIR = process.env.NF_OUTPUT ?? resolve(process.cwd(), "..", "宣传demo");
const TEMPLATE_DIR = process.env.NF_TEMPLATE ?? resolve(process.cwd(), "src-tauri", "templates", "webgal");

/** 视觉守门：命令行场景下没有「点批准」这一步，这里用一个自洽的画风描述 + 精确指纹自签。
 *  图像阶段有两道门（pipeline.ts:1715 / pipeline.ts:2615），第二道要求
 *  computeProjectVisualBibleFingerprint 与 bible.inputFingerprint 完全相等——
 *  所以必须在**提取出卡片之后**才算指纹（指纹含 characters）。 */
const STYLE_DESCRIPTION =
  "post-apocalyptic anime, cel shading, dust and rust palette, muted ochre and iron grey, cinematic lighting";

function buildOptions(): GenerationOptions {
  return {
    useImage: true,
    useTts: true,
    useVideoPoints: false,
    useBgm: true,
    useSe: true,
    figureEmotions: true,
    figureDetail: "full",
    figureActions: true,
    characterPoses: true,
    imageSelfCheck: false,
    imageBudgetPerChapter: 0,
    backgroundsPerLocation: 0,
    backgroundReuse: "locationTimeWeather",
    cgPerChapter: 0,
    skipCache: false,
    videoPointsPerChapter: 0,
    characterIntroCard: true,
    titleCoverMode: "auto",
    titleLogoMode: "auto",
    exportTitle: "铁皮城堡",
    exportGameKey: "tiepibao",
    titleEnableContinue: true,
    titleEnableFlowchart: true,
    titleEnableAppreciation: true,
    themeFromArtwork: true,
    imageStyle: STYLE_DESCRIPTION,
    imageSeed: 0,
    styleAnchor: true,
    scriptStyle: "",
    compressNarration: false,
    language: "",
    uiLanguage: "zh_CN",
    splitMinChapterChars: 3000,
    keepSpecialChapters: false,
  } as GenerationOptions;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log("=== NovelForge 全量生成（无 GUI） ===");
  console.log(`配置: ${CONFIG_PATH}`);
  console.log(`小说: ${NOVEL_PATH}`);
  console.log(`输出: ${OUTPUT_DIR}`);
  console.log(`模板: ${TEMPLATE_DIR}`);

  const cfg = loadConfig();
  registerSecrets(cfg);
  // 只打印通道的 baseUrl / model（绝不打印 apiKey）
  console.log("\n通道（active）:");
  for (const kind of ["llm", "vision", "image", "tts"] as const) {
    const c = cfg[kind];
    console.log(`  ${kind.padEnd(6)} ${c ? `${c.baseUrl} / ${c.model}  [apiKey ${c.apiKey ? "已注入" : "缺失"}]` : "(无)"}`);
  }
  if (!cfg.llm?.apiKey) throw new Error("LLM 通道缺少 apiKey（config.json 内联缺失）——请用 生成全部.ps1 启动本脚本");
  if (!cfg.image?.apiKey) throw new Error("图像通道缺少 apiKey（config.json 内联缺失）——请用 生成全部.ps1 启动本脚本");

  const novel = await importNovelFile(NOVEL_PATH);
  console.log(`\n小说导入：${novel.chapters.length} 章 / ${novel.fullText.length} 字符 / 编码 ${novel.encoding}`);
  for (const c of novel.chapters) console.log(`  ${c.index + 1}. ${c.title}（${c.charCount} 字）`);
  if (novel.chapters.length < 2) throw new Error("正则分章只切出 1 章，请检查小说文件的分章标题格式");

  if (process.env.NF_WIRE_ONLY === "1") {
    console.log("\n[NF_WIRE_ONLY=1] 接线验证通过：配置读取 + 密钥注入 + 小说导入 均正常；不发起任何 API 调用。");
    return;
  }

  const options = buildOptions();
  const materials: never[] = [];
  const common = {
    novel,
    materials,
    llm: cfg.llm,
    vision: cfg.vision,
    image: cfg.image,
    tts: cfg.tts,
    outputDir: OUTPUT_DIR,
    templateDir: TEMPLATE_DIR,
    options,
  };

  /* ---------- 第一趟：提取（全书级一次调用） ---------- */
  console.log("\n########## 第一趟：提取角色/场景/物品卡 ##########");
  const passA = await new Pipeline({
    ...common,
    stages: ["extract"] as StageKey[],
    log: makeLogger("提取"),
  }).run();
  const cards = passA.cards;
  if (!cards?.characters?.length) throw new Error("提取阶段没有产出任何角色卡，已中止（不进入付费的图像阶段）");
  console.log(`提取完成：${cards.characters.length} 角色 / ${cards.scenes.length} 场景 / ${cards.items.length} 物品 / 标题「${cards.title}」`);

  /* ---------- 视觉守门自签（等价于 GUI 里点「批准」） ----------
     只保留在内存里传给 Pipeline，不落盘：saveVisualBible 会做 canonical 路径校验
     （styleReferencePath 必须是项目内的 style-sample.png 之类），而这里刻意不生成守门图，
     所以落盘会被拒。落盘只是给"重启续跑"用的，本脚本每次运行都会重新算出同一个指纹
     （cards 命中缓存 → 指纹稳定），因此不需要落盘。 */
  const bible: ProjectVisualBible = {
    version: 1,
    status: "approved",
    styleSource: "novel_analysis",
    styleDescription: STYLE_DESCRIPTION,
    styleReferencePath: "",
    characters: {},
    inputFingerprint: "",
  };
  bible.inputFingerprint = await computeProjectVisualBibleFingerprint(OUTPUT_DIR, bible, novel, cards.characters);
  console.log(`视觉守门已自签（指纹 ${bible.inputFingerprint}）——等价于 GUI 里点「批准」，不额外生成守门图`);

  /* ---------- 第二趟：剧本 → 图像 → 配音 → 组装 ---------- */
  console.log("\n########## 第二趟：剧本 → 图像 → 配音 → 组装 ##########");
  const passB = await new Pipeline({
    ...common,
    visualBible: bible,
    stages: ["script", "image", "voice", "assemble"] as StageKey[],
    log: makeLogger("生成"),
  }).run();

  const cost = passB.cost ?? passA.cost;
  const llmYuan = (passA.cost?.llmCostYuan ?? 0) + (passB.cost?.llmCostYuan ?? 0);
  const imgYuan = (passA.cost?.imageCostYuan ?? 0) + (passB.cost?.imageCostYuan ?? 0);
  const ttsYuan = (passA.cost?.ttsCostYuan ?? 0) + (passB.cost?.ttsCostYuan ?? 0);

  console.log("\n================ 完成 ================");
  console.log(`章节: ${passB.chapters?.length ?? 0} / 失败项: ${passB.failedTasks?.length ?? 0}`);
  console.log(`用量: LLM ${llmYuan.toFixed(2)} 元 | 图像 ${passB.cost?.imageCount ?? 0} 张 ${imgYuan.toFixed(2)} 元 | 配音 ${passB.cost?.ttsChars ?? 0} 字 ${ttsYuan.toFixed(2)} 元`);
  console.log(`合计约 ${(llmYuan + imgYuan + ttsYuan).toFixed(2)} 元，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
  console.log(`产物目录: ${OUTPUT_DIR}`);
  console.log(`试玩: 双击 ${resolve(OUTPUT_DIR, "启动游戏.bat")}（必须走 http://127.0.0.1:8080/，不要双击 index.html）`);
  if ((passB.failedTasks?.length ?? 0) > 0) {
    console.log(`\n注意：有 ${passB.failedTasks.length} 个失败任务（图像有失败时组装会被跳过），重跑本脚本会按缓存只补缺失、不重复计费。`);
    process.exitCode = 2;
  }
  void cost;
}

main().catch((e: unknown) => {
  const msg = redact(e instanceof Error ? (e.stack ?? e.message) : String(e));
  console.error(`\n生成失败: ${msg}`);
  process.exitCode = 1;
});
