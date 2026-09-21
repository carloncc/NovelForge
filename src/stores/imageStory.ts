/**
 * 图片小说（纯图片模式）独立状态与运行控制器（#805）。
 * 与 generate 链路完全隔离：独立输出目录（<用户所选目录>/<书名>-图片版/）、独立缓存与持久化，
 * 仅复用主项目的「原文与分章」（#814 决策 2）与 API 配置（只读）。
 */
import { computed, reactive, watch } from "vue";
import type {
  AssetMap,
  ChapterInfo,
  ChapterScript,
  ExtractionResult,
  ImageStoryOptions,
  PipelineEvent,
} from "../core/types";
import { t } from "../i18n";
import { activeConfig, voiceLibraryFor } from "./config";
import { setActiveAbortSignal } from "../api/abort";
import { projectState } from "./project";
import { goPage } from "./nav";
import { tauri, isTauri, downloadZipWeb } from "../utils/tauri";
import { errMsg } from "../utils/errors";
import { log as logger } from "../utils/logger";
import { readAssetMap, updateAssetMap, backupAssetMap, emptyAssetMap } from "../core/assetMap";
import { parseChapterScript } from "../core/dataValidation";
import { scriptCacheFileName, scriptFingerprint, titleHash } from "../core/cache";
import { scriptChapter } from "../core/script";
import { extractFromNovelChunked } from "../core/extractAgent";
import { translateChapter } from "../core/translate";
import { buildImageStoryPlan, runImageStoryTasks, IMAGE_YUAN_EACH } from "../core/imageStory";
import { assembleProject, gameKeyFor } from "../core/project";
import { inferWebgalLanguage } from "../core/render";
import { resolveTemplateDir } from "../utils/template";

/* ==================== 状态 ==================== */

export interface ImageStoryFailedItem {
  key: string;
  label: string;
  message: string;
}

export interface ImageStoryState {
  outputDir: string;
  options: ImageStoryOptions;
  cards: ExtractionResult | null;
  chapters: ChapterScript[];
  assets: AssetMap;
  logs: PipelineEvent[];
  running: boolean;
  stopping: boolean;
  stage: string;
  progress: { done: number; total: number } | null;
  plan: { shots: number; threeviews: number; items: number; total: number; yuan: number } | null;
  produced: number;
  failed: ImageStoryFailedItem[];
  lastError: string;
  previewUrl: string;
  zipBusy: boolean;
  lastZipPath: string;
  loaded: boolean;
}

const DEFAULT_OPTIONS: ImageStoryOptions = {
  shotsPerScene: 0,
  shotsPerChapter: 0,
  shotsTotal: 0,
  imageStyle: "",
  imageSeed: 0,
  imageSelfCheck: false,
  includeItems: false,
  language: "",
  styleAnchor: true,
};

export const imageStoryState = reactive<ImageStoryState>({
  outputDir: "",
  options: { ...DEFAULT_OPTIONS },
  cards: null,
  chapters: [],
  assets: emptyAssetMap(),
  logs: [],
  running: false,
  stopping: false,
  stage: "",
  progress: null,
  plan: null,
  produced: 0,
  failed: [],
  lastError: "",
  previewUrl: "",
  zipBusy: false,
  lastZipPath: "",
  loaded: false,
});

/** 输出的图片小说输出目录：默认与主项目同级的 `<书名>-图片版/`，可手动改 */
export function defaultImageStoryDir(): string {
  const main = (projectState.outputDir || "").replace(/[\\/]+$/, "");
  const title = projectState.novel?.fileName?.replace(/\.txt$/i, "") || t("未命名作品");
  if (!main) return `${title}-图片版`;
  const parent = main.includes("/") || main.includes("\\") ? main.replace(/[\\/][^\\/]*$/, "") : "";
  return `${parent ? `${parent}/` : ""}${title}-图片版`;
}

function pushLog(step: string, message: string, level: PipelineEvent["level"] = "info"): void {
  imageStoryState.logs.push({ step, message, level, at: Date.now() });
  if (imageStoryState.logs.length > 500) imageStoryState.logs.splice(0, imageStoryState.logs.length - 500);
}

const META_FILE = (dir: string): string => `${dir}/.novel2vn/image-story.json`;
const CACHE_ROOT = (dir: string): string => `${dir}/.novel2vn/cache`;

let saveChain: Promise<void> = Promise.resolve();
function persist(): void {
  const dir = imageStoryState.outputDir;
  if (!dir) return;
  const payload = JSON.stringify({ version: 1, outputDir: dir, options: imageStoryState.options }, null, 2);
  saveChain = saveChain
    .then(() => tauri.mkdirAll(`${dir}/.novel2vn`))
    .then(() => tauri.writeTextFile(META_FILE(dir), payload))
    .catch((e) => logger.warn("imageStory", "图片小说状态保存失败", { error: errMsg(e).slice(0, 200) }));
}

/** 载入独立状态（页面挂载时调用一次）：独立目录/选项记忆，卡与剧本从磁盘恢复 */
export async function loadImageStoryState(): Promise<void> {
  if (imageStoryState.loaded) return;
  imageStoryState.loaded = true;
  // 候选目录：上次保存的（主项目同级扫描过深，这里只认自身记录）
  let dir = "";
  try {
    const raw = localStorage.getItem("novelforge:image-story-dir");
    if (raw) dir = raw;
  } catch {
    /* 忽略 */
  }
  if (!dir) dir = defaultImageStoryDir();
  imageStoryState.outputDir = dir;
  try {
    const { text } = await tauri.readTextFile(META_FILE(dir));
    const parsed = JSON.parse(text) as { options?: Partial<ImageStoryOptions> };
    imageStoryState.options = { ...DEFAULT_OPTIONS, ...(parsed.options ?? {}) };
  } catch {
    /* 首次使用：默认选项 */
  }
  try {
    localStorage.setItem("novelforge:image-story-dir", dir);
  } catch {
    /* 忽略 */
  }
  await refreshFromDisk();
}

/** 从磁盘恢复卡片/剧本/图片映射（换目录或生成结束后调用） */
export async function refreshFromDisk(): Promise<void> {
  const dir = imageStoryState.outputDir;
  if (!dir) return;
  try {
    const { text } = await tauri.readTextFile(`${dir}/.novel2vn/cards.json`);
    const parsed = JSON.parse(text) as ExtractionResult;
    imageStoryState.cards = Array.isArray(parsed.characters) ? parsed : null;
  } catch {
    imageStoryState.cards = null;
  }
  try {
    imageStoryState.assets = await readAssetMap(dir);
  } catch {
    imageStoryState.assets = emptyAssetMap();
  }
  imageStoryState.chapters = await readCachedChapters();
  refreshPlan();
}

export function setImageStoryDir(dir: string): void {
  imageStoryState.outputDir = dir;
  try {
    localStorage.setItem("novelforge:image-story-dir", dir);
  } catch {
    /* 忽略 */
  }
  void refreshFromDisk();
}

watch(
  () => JSON.stringify(imageStoryState.options),
  () => {
    persist();
    refreshPlan();
  },
);

/* ==================== 计划与费用 ==================== */

const enabledChapters = computed(() => projectState.novel?.chapters.filter((c) => c.enabled !== false) ?? []);

/** 当前已生成剧本的分镜/三视图/物品任务总账（生成前预估与结果区共用） */
function refreshPlan(): void {
  const cards = imageStoryState.cards;
  const scripts = imageStoryState.chapters;
  if (!cards || !scripts.length) {
    imageStoryState.plan = null;
    return;
  }
  const plan = buildImageStoryPlan(scripts, cards, imageStoryState.options);
  imageStoryState.plan = {
    shots: plan.shotCount,
    threeviews: plan.threeviewCount,
    items: plan.itemCount,
    total: plan.tasks.length,
    yuan: plan.estimatedYuan,
  };
}

/** 预估：尚无剧本时按「章节数 × 4 场景 × 每场景张数（默认 2）」粗估，供生成前提示 */
export const imageStoryEstimate = computed(() => {
  const plan = imageStoryState.plan;
  if (plan) {
    return { total: plan.total, yuan: plan.yuan, exact: true as const };
  }
  const chapters = enabledChapters.value.length;
  const perScene = imageStoryState.options.shotsPerScene > 0 ? imageStoryState.options.shotsPerScene : 2;
  const perChapter = imageStoryState.options.shotsPerChapter > 0 ? imageStoryState.options.shotsPerChapter : 0;
  const shots = perChapter > 0 ? Math.min(chapters * perChapter, chapters * 4 * perScene) : chapters * 4 * perScene;
  const total = shots + (imageStoryState.cards?.characters.length ?? 0);
  return { total, yuan: Math.round(total * IMAGE_YUAN_EACH * 100) / 100, exact: false as const };
});

/* ==================== 读取/缓存 ==================== */

const scriptFp = (): string =>
  scriptFingerprint({
    style: imageStoryState.options.imageStyle,
    compressNarration: false,
    visualMode: "imageOnly",
  });

async function readCachedChapters(): Promise<ChapterScript[]> {
  const dir = imageStoryState.outputDir;
  const chapters = enabledChapters.value;
  if (!dir || !chapters.length) return [];
  const fp = scriptFp();
  const cacheDir = CACHE_ROOT(dir);
  const out: ChapterScript[] = [];
  for (const ch of chapters) {
    const eff = await effectiveChapterText(ch);
    const file = scriptCacheFileName(cacheDir, false, ch.index, eff.title, eff.text, fp);
    try {
      const { text } = await tauri.readTextFile(file);
      const script = parseChapterScript(JSON.parse(text));
      out.push(script);
    } catch {
      /* 未生成 */
    }
  }
  return out.sort((a, b) => a.chapter - b.chapter);
}

/** 翻译复用：优先读主项目的翻译缓存（同一本小说只翻一次），否则按需翻译 */
async function effectiveChapterText(ch: ChapterInfo): Promise<{ title: string; text: string }> {
  const lang = (imageStoryState.options.language ?? "").trim();
  if (!lang) return { title: ch.title, text: ch.text };
  const mainDir = projectState.outputDir;
  if (mainDir) {
    const mainFile = `${mainDir}/.novel2vn/translate/translate_${lang}_${titleHash(ch.title)}_${titleHash(ch.text)}.json`;
    try {
      const { text } = await tauri.readTextFile(mainFile);
      const parsed = JSON.parse(text) as { title?: string; text?: string };
      if (typeof parsed.title === "string" && typeof parsed.text === "string") return { title: parsed.title, text: parsed.text };
    } catch {
      /* 无主项目译文，继续 */
    }
  }
  const ownFile = `${imageStoryState.outputDir}/.novel2vn/translate/translate_${lang}_${titleHash(ch.title)}_${titleHash(ch.text)}.json`;
  try {
    const { text } = await tauri.readTextFile(ownFile);
    const parsed = JSON.parse(text) as { title?: string; text?: string };
    if (typeof parsed.title === "string" && typeof parsed.text === "string") return { title: parsed.title, text: parsed.text };
  } catch {
    /* 需要翻译 */
  }
  const llm = activeConfig("llm");
  if (!llm?.apiKey) return { title: ch.title, text: ch.text };
  try {
    const translated = await translateChapter(llm, ch, lang, undefined, undefined);
    await tauri.mkdirAll(`${imageStoryState.outputDir}/.novel2vn/translate`);
    await tauri.writeTextFile(ownFile, JSON.stringify(translated, null, 2));
    return translated;
  } catch (e) {
    pushLog("翻译", `第 ${ch.index + 1} 章翻译失败，改用原文：${errMsg(e).slice(0, 120)}`, "warn");
    return { title: ch.title, text: ch.text };
  }
}

/* ==================== 运行 ==================== */

let abortFlag = false;
/** #784：图片小说自己的中止信号（停止时同时中断在途 LLM/图像请求） */
let imageStoryAbort = new AbortController();

function beginAbortableRun(): void {
  imageStoryAbort = new AbortController();
  abortFlag = false;
  setActiveAbortSignal(imageStoryAbort.signal);
}

function endAbortableRun(): void {
  setActiveAbortSignal(undefined);
}

export function stopImageStory(): void {
  if (!imageStoryState.running) return;
  abortFlag = true;
  imageStoryAbort.abort();
  imageStoryState.stopping = true;
  pushLog("运行", "已请求停止：不再派发新的付费请求，在途请求已中断", "warn");
}

async function ensureOutputDir(): Promise<void> {
  const dir = imageStoryState.outputDir;
  await tauri.mkdirAll(`${dir}/.novel2vn/cache`);
  persist();
}

async function runExtractStage(llm: NonNullable<ReturnType<typeof activeConfig>>): Promise<ExtractionResult> {
  const dir = imageStoryState.outputDir;
  const cardsFile = `${dir}/.novel2vn/cards.json`;
  try {
    const { text } = await tauri.readTextFile(cardsFile);
    const parsed = JSON.parse(text) as ExtractionResult;
    if (Array.isArray(parsed.characters)) {
      pushLog("提取", `卡片缓存命中：${parsed.characters.length} 角色 / ${parsed.scenes?.length ?? 0} 场景 / ${parsed.items?.length ?? 0} 物品`);
      return parsed;
    }
  } catch {
    /* 首次提取 */
  }
  const novel = projectState.novel!;
  pushLog("提取", `开始提取卡片（${Math.round(novel.fullText.length / 1000)}k 字，按上下文分段扫描）…`);
  const result = await extractFromNovelChunked(llm, novel.fullText, novel.fileName.replace(/\.txt$/i, ""), {
    log: (message, level = "info") => pushLog("提取", message, level),
    isAborted: () => abortFlag,
    voiceLib: voiceLibraryFor(activeConfig("tts")),
  });
  await tauri.writeTextFile(cardsFile, JSON.stringify(result, null, 2));
  pushLog("提取", `卡片完成：${result.characters.length} 角色 / ${result.scenes.length} 场景 / ${result.items.length} 物品`, "success");
  return result;
}

async function runScriptStage(llm: NonNullable<ReturnType<typeof activeConfig>>, cards: ExtractionResult): Promise<ChapterScript[]> {
  const dir = imageStoryState.outputDir;
  const cacheDir = CACHE_ROOT(dir);
  const fp = scriptFp();
  const out: ChapterScript[] = [];
  const chapters = enabledChapters.value;
  for (let i = 0; i < chapters.length; i++) {
    if (abortFlag) break;
    const ch = chapters[i];
    const eff = await effectiveChapterText(ch);
    imageStoryState.stage = "剧本";
    imageStoryState.progress = { done: i, total: chapters.length };
    const file = scriptCacheFileName(cacheDir, false, ch.index, eff.title, eff.text, fp);
    try {
      const { text } = await tauri.readTextFile(file);
      out.push(parseChapterScript(JSON.parse(text)));
      pushLog("剧本", `第 ${ch.index + 1} 章分镜剧本命中缓存`);
      continue;
    } catch {
      /* 需要生成 */
    }
    pushLog("剧本", `第 ${ch.index + 1}/${chapters.length} 章：生成分镜剧本…`);
    try {
      const script = await scriptChapter(llm, { ...ch, title: eff.title, text: eff.text }, cards, undefined, {
        mode: "imageOnly",
        shotsPerScene: imageStoryState.options.shotsPerScene,
        compressNarration: false,
        style: imageStoryState.options.imageStyle || undefined,
      });
      await tauri.mkdirAll(cacheDir);
      await tauri.writeTextFile(file, JSON.stringify(script, null, 2));
      out.push(script);
      const shots = script.scenes.reduce((n, s) => n + (s.shots?.length ?? 0), 0);
      pushLog("剧本", `第 ${ch.index + 1} 章完成：${script.scenes.length} 场景 / ${shots} 分镜`, "success");
    } catch (e) {
      pushLog("剧本", `第 ${ch.index + 1} 章分镜剧本失败：${errMsg(e).slice(0, 160)}`, "error");
      imageStoryState.failed.push({ key: `script_ch${ch.index + 1}`, label: `第 ${ch.index + 1} 章剧本`, message: errMsg(e).slice(0, 300) });
    }
  }
  imageStoryState.progress = null;
  return out.sort((a, b) => a.chapter - b.chapter);
}

async function runImageStage(cards: ExtractionResult, chapters: ChapterScript[]): Promise<void> {
  const dir = imageStoryState.outputDir;
  const imageCfg = activeConfig("image");
  if (!imageCfg?.apiKey) {
    pushLog("图片", "未配置图像 API，跳过图片生成（可在「API 配置」页配置）", "warn");
    return;
  }
  const plan = buildImageStoryPlan(chapters, cards, imageStoryState.options);
  if (!plan.tasks.length) {
    pushLog("图片", "没有可生成的分镜任务（请先完成剧本，或提高张数上限）", "warn");
    return;
  }
  imageStoryState.plan = { shots: plan.shotCount, threeviews: plan.threeviewCount, items: plan.itemCount, total: plan.tasks.length, yuan: plan.estimatedYuan };
  pushLog("图片", `开始生成图片：分镜 ${plan.shotCount} 张 / 三视图 ${plan.threeviewCount} 张 / 物品 ${plan.itemCount} 张（预计最多 ¥${plan.estimatedYuan}，命中缓存不重复计费）`);
  const assets = await readAssetMap(dir);
  await backupAssetMap(dir).catch(() => null);
  let done = 0;
  const result = await runImageStoryTasks({
    cfg: imageCfg,
    tasks: plan.tasks,
    cacheRoot: CACHE_ROOT(dir),
    outputDir: dir,
    concurrency: 3,
    isAborted: () => abortFlag,
    log: (ev) => pushLog(ev.step || "图片", ev.message, ev.level),
    verifyCfg: imageStoryState.options.imageSelfCheck ? activeConfig("vision") : undefined,
    visionCfg: activeConfig("vision"),
    safeRewriteCfg: activeConfig("llm"),
    onTaskDone: (task, path) => {
      done++;
      imageStoryState.progress = { done, total: plan.tasks.length };
      imageStoryState.produced++;
      if (task.kind === "shot") assets.shot = { ...(assets.shot ?? {}), [task.id]: path };
      else if (task.kind === "threeview") assets.figure[task.id] = path;
      else if (task.kind === "item") assets.item[task.id] = path;
      void updateAssetMap(dir, (map) => {
        if (task.kind === "shot") map.shot = { ...(map.shot ?? {}), [task.id]: path };
        else if (task.kind === "threeview") map.figure[task.id] = path;
        else if (task.kind === "item") map.item[task.id] = path;
      }).catch(() => undefined);
    },
    onTaskFailed: (task, message) => {
      imageStoryState.failed.push({ key: task.id, label: task.usage || task.fileName, message });
      pushLog("图片", `${task.usage || task.id} 失败：${message.slice(0, 160)}`, "error");
    },
  });
  imageStoryState.assets = await readAssetMap(dir);
  imageStoryState.progress = null;
  pushLog("图片", `图片完成：产出 ${result.produced} 张，失败 ${result.failed} 张`, result.failed ? "warn" : "success");
}

async function runAssembleStage(cards: ExtractionResult, chapters: ChapterScript[]): Promise<void> {
  const dir = imageStoryState.outputDir;
  imageStoryState.stage = "组装";
  const templateDir = await resolveTemplateDir();
  const assets = await readAssetMap(dir);
  const title = (projectState.novel?.fileName ?? "图片小说").replace(/\.txt$/i, "");
  const sample = chapters
    .slice(0, 3)
    .map((c) => `${c.title} ${c.scenes.map((s) => s.location).join(" ")}`)
    .join(" ");
  await tauri.mkdirAll(`${dir}/.novel2vn`);
  await assembleProject({
    outputDir: dir,
    title,
    gameKey: gameKeyFor(title),
    templateDir,
    chapters,
    cards,
    assets,
    mode: "imageOnly",
    introCard: false,
    figureEmotions: false,
    figureActions: false,
    useBgm: true,
    useSe: true,
    language: inferWebgalLanguage(sample || title),
    log: (message) => pushLog("组装", message),
  });
  pushLog("组装", "组装完成（可预览或导出 zip）", "success");
}

/** 一键运行：提取 → 分镜剧本 → 图片 → 组装（复用缓存，只补缺失） */
export async function runImageStory(): Promise<void> {
  if (imageStoryState.running) return;
  const novel = projectState.novel;
  if (!novel) {
    imageStoryState.lastError = t("请先在「导入小说」页导入小说（或加载示例小说）");
    return;
  }
  const llm = activeConfig("llm");
  if (!llm?.apiKey) {
    imageStoryState.lastError = t("请先在「API 配置」页配置文本 LLM（分镜剧本需要）");
    return;
  }
  abortFlag = false;
  beginAbortableRun();
  imageStoryState.running = true;
  imageStoryState.stopping = false;
  imageStoryState.failed = [];
  imageStoryState.produced = 0;
  imageStoryState.lastError = "";
  imageStoryState.logs = [];
  try {
    await ensureOutputDir();
    imageStoryState.stage = "提取";
    pushLog("运行", `图片小说输出目录：${imageStoryState.outputDir}`);
    const cards = await runExtractStage(llm);
    imageStoryState.cards = cards;
    const chapters = await runScriptStage(llm, cards);
    imageStoryState.chapters = chapters;
    refreshPlan();
    if (!abortFlag && chapters.length) await runImageStage(cards, chapters);
    if (!abortFlag && chapters.length) await runAssembleStage(cards, chapters);
    if (abortFlag) pushLog("运行", "已停止（已完成的产物与缓存保留）", "warn");
    else pushLog("运行", `全部完成：分镜剧本 ${chapters.length} 章，图片产出 ${imageStoryState.produced} 张`, "success");
    await refreshFromDisk();
  } catch (e) {
    imageStoryState.lastError = errMsg(e).slice(0, 400);
    pushLog("运行", `运行失败：${imageStoryState.lastError}`, "error");
  } finally {
    imageStoryState.running = false;
    imageStoryState.stopping = false;
    imageStoryState.stage = "";
    imageStoryState.progress = null;
    endAbortableRun();
    persist();
  }
}

/** 重试失败项：先补齐缺剧本的章节，再复用缓存重跑图片阶段（已完成的不会重复计费）并重新组装 */
export async function retryFailedImages(): Promise<void> {
  if (imageStoryState.running) return;
  const cards = imageStoryState.cards;
  if (!cards) return;
  const llm = activeConfig("llm");
  if (!llm?.apiKey) {
    imageStoryState.lastError = t("请先在「API 配置」页配置文本 LLM（分镜剧本需要）");
    return;
  }
  imageStoryState.running = true;
  abortFlag = false;
  beginAbortableRun();
  imageStoryState.failed = [];
  try {
    const chapters = await runScriptStage(llm, cards);
    imageStoryState.chapters = chapters;
    refreshPlan();
    if (chapters.length) {
      await runImageStage(cards, chapters);
      await runAssembleStage(cards, chapters);
    }
    await refreshFromDisk();
  } catch (e) {
    imageStoryState.lastError = errMsg(e).slice(0, 400);
  } finally {
    imageStoryState.running = false;
    endAbortableRun();
  }
}

/** 单张分镜重生成（强制覆盖该张；依赖的三视图走缓存） */
export async function regenerateShot(taskId: string): Promise<void> {
  if (imageStoryState.running) return;
  const cards = imageStoryState.cards;
  const chapters = imageStoryState.chapters;
  const dir = imageStoryState.outputDir;
  const imageCfg = activeConfig("image");
  if (!cards || !chapters.length || !imageCfg?.apiKey) return;
  const plan = buildImageStoryPlan(chapters, cards, imageStoryState.options);
  const task = plan.tasks.find((t) => t.kind === "shot" && t.id === taskId);
  if (!task) return;
  const assets = await readAssetMap(dir);
  const figureBase: Record<string, string> = {};
  for (const [id, path] of Object.entries(assets.figure)) figureBase[id] = path;
  // 依赖的三视图缺失时不单张重生成（避免静默降级为纯文生图导致人物不一致）
  if (task.characterId && !figureBase[`${task.characterId}_threeview`]) {
    pushLog("图片", `角色 ${task.characterId} 的三视图缺失：请先重跑图片阶段补齐三视图后再重生成该分镜`, "error");
    return;
  }
  imageStoryState.running = true;
  beginAbortableRun();
  try {
    await runImageStoryTasks({
      cfg: imageCfg,
      tasks: [task],
      cacheRoot: CACHE_ROOT(dir),
      outputDir: dir,
      concurrency: 1,
      isAborted: () => abortFlag,
      force: true,
      log: (ev) => pushLog(ev.step || "图片", ev.message, ev.level),
      verifyCfg: imageStoryState.options.imageSelfCheck ? activeConfig("vision") : undefined,
      onTaskDone: (t2, path) => {
        void updateAssetMap(dir, (map) => {
          map.shot = { ...(map.shot ?? {}), [t2.id]: path };
        }).catch(() => undefined);
      },
      onTaskFailed: (t2, message) => {
        pushLog("图片", `${t2.usage || t2.id} 重生成失败：${message.slice(0, 160)}`, "error");
      },
    });
    await refreshFromDisk();
  } finally {
    imageStoryState.running = false;
    endAbortableRun();
  }
}

/* ==================== 预览与导出 ==================== */

export async function startImageStoryPreview(): Promise<void> {
  const dir = imageStoryState.outputDir;
  if (!dir) return;
  try {
    await tauri.stopPreviewServer().catch(() => undefined);
    const res = await tauri.startPreviewServer(dir);
    imageStoryState.previewUrl = res.url;
    pushLog("预览", `预览已启动：${res.url}`, "success");
  } catch (e) {
    pushLog("预览", `预览启动失败：${errMsg(e).slice(0, 160)}`, "error");
  }
}

export async function exportImageStoryZip(): Promise<void> {
  const dir = imageStoryState.outputDir;
  if (!dir) return;
  imageStoryState.zipBusy = true;
  try {
    const base = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "image-story";
    if (!isTauri()) {
      const { fileCount, sizeBytes } = await downloadZipWeb(dir, [".novel2vn"], `${base}_web.zip`);
      pushLog("导出", `已下载 zip：${fileCount} 文件 / ${(sizeBytes / 1024 / 1024).toFixed(1)}MB`, "success");
      return;
    }
    const { save } = await import("@tauri-apps/plugin-dialog");
    const target = await save({
      defaultPath: `${dir.replace(/[\\/]+$/, "")}_web.zip`,
      filters: [{ name: t("ZIP 压缩包"), extensions: ["zip"] }],
    });
    if (!target) return;
    const stats = await tauri.buildZip(dir, target, [".novel2vn"]);
    imageStoryState.lastZipPath = target;
    pushLog("导出", `已打包 zip：${target}（${stats.fileCount} 文件）`, "success");
  } catch (e) {
    pushLog("导出", `打包失败：${errMsg(e).slice(0, 160)}`, "error");
  } finally {
    imageStoryState.zipBusy = false;
  }
}

/** 分镜结果（按章节分组，供结果区网格） */
export const imageStoryShots = computed(() => {
  const assets = imageStoryState.assets;
  const out: { chapter: number; title: string; scene: string; shots: { id: string; path: string; note: string }[] }[] = [];
  for (const script of imageStoryState.chapters) {
    for (const scene of script.scenes) {
      const shots = (scene.shots ?? [])
        .filter((s) => assets.shot?.[s.id])
        .map((s) => ({ id: s.id, path: assets.shot![s.id], note: s.note || scene.location }));
      if (shots.length) {
        const ch = out.find((o) => o.chapter === script.chapter);
        const entry = ch ?? { chapter: script.chapter, title: script.title, scene: "", shots: [] };
        entry.shots.push(...shots);
        if (!ch) out.push(entry);
      }
    }
  }
  return out.sort((a, b) => a.chapter - b.chapter);
});

export function goImport(): void {
  goPage("import");
}
