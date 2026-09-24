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
import { concurrencyFor } from "./configMigration";
import { registerRunAbort, unregisterRunAbort } from "../api/abort";
import { runIsBusy, runStatusSyncSource, registerRunStopSource } from "./runStatus";
import { previewOwner, claimPreview, releasePreview } from "./preview";
import { projectState } from "./project";
import { goPage } from "./nav";
import { tauri, isTauri, downloadZipWeb, blessParentDir, isPathInsideDir } from "../utils/tauri";
import { errMsg } from "../utils/errors";
import { log as logger } from "../utils/logger";
import { readAssetMap, updateAssetMap, backupAssetMap, emptyAssetMap } from "../core/assetMap";
import { parseChapterScript } from "../core/dataValidation";
import { scriptCacheFileName, scriptFingerprint, titleHash, cardsFingerprint } from "../core/cache";
import { scriptChapter } from "../core/script";
import { extractFromNovelChunked } from "../core/extractAgent";
import { translateChapter } from "../core/translate";
import {
  buildImageStoryPlan,
  deriveImageStoryDir,
  estimateImageStoryPlan,
  mergeImageStoryLogs,
  normalizeShotTriggers,
  planChapterContinuity,
  resolveImageStoryDirOnLoad,
  runImageStoryTasks,
  shouldBlockAssembleOnZeroShots,
  shouldRunPostScriptStages,
} from "../core/imageStory";
import { shotCharacterIdsOf } from "../core/images";
import { assembleProject, gameKeyFor } from "../core/project";
// #1140：图片小说配音阶段复用主管线 TTS 管线（buildVoiceJobs/generateVoice 按台词行出音频）
import { buildVoiceJobs, generateVoice, pruneStaleImageStoryVocal, toImageStoryVoiceFailedItem } from "../core/voice";
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
  /** 剧本/台词文风（#1098）：与图像画风 imageStyle 分离，只进剧本指纹与剧本提示词 */
  scriptStyle: string;
  /** 目录自动跟随主项目（#1101）：手动选择目录后置 false */
  dirAuto: boolean;
  /** 当前目录绑定的主项目指纹（#1101）：与当前主项目不一致时提示「目录属于其他作品」 */
  dirProjectKey: string;
  /** 组装：BGM 开关（#1104） */
  useBgm: boolean;
  /** 组装：环境音效（SE）开关（#1104） */
  useSe: boolean;
  /** 配音开关（#1140，默认关）：开启时跑配音阶段，复用主管线 TTS 配置与音色库 */
  useVoice: boolean;
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
  /** 预览服务器是否由本页启动且仍在运行（#1102：停止后不再显示「预览已启动」） */
  previewRunning: boolean;
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
  scriptStyle: "",
  dirAuto: true,
  dirProjectKey: "",
  useBgm: true,
  useSe: true,
  useVoice: false, // #1140：配音默认关闭
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
  previewRunning: false,
  zipBusy: false,
  lastZipPath: "",
  loaded: false,
});

/** 主项目指纹（#1101）：目录归属判定用；不含小说正文，避免切章就误判换作品 */
function mainProjectKey(): string {
  const main = (projectState.outputDir || "").replace(/[\\/]+$/, "");
  const title = projectState.novel?.fileName ?? "";
  if (!main && !title) return "";
  return titleHash(`${main}|${title}`);
}

/** 输出的图片小说输出目录：默认与主项目同级的 `<书名>-图片版/`，可手动改 */
export function defaultImageStoryDir(): string {
  const title = projectState.novel?.fileName?.replace(/\.txt$/i, "") || t("未命名作品");
  return deriveImageStoryDir(projectState.outputDir || "", title);
}

/** 当前目录是否属于其他作品（手动指定的目录 + 主项目已切换） */
export const imageStoryDirForeign = computed(
  () => !imageStoryState.dirAuto && !!imageStoryState.dirProjectKey && imageStoryState.dirProjectKey !== mainProjectKey(),
);

function pushLog(step: string, message: string, level: PipelineEvent["level"] = "info"): void {
  const ev: PipelineEvent = { step, message, level, at: Date.now() };
  imageStoryState.logs.push(ev);
  if (imageStoryState.logs.length > 500) imageStoryState.logs.splice(0, imageStoryState.logs.length - 500);
  // #1148：日志同步写入 <图片版目录>/.novel2vn/image-story.log（JSONL），关掉应用后可恢复
  diskLogEvents.push(ev);
  if (diskLogEvents.length > LOG_FILE_LIMIT) diskLogEvents.splice(0, diskLogEvents.length - LOG_FILE_LIMIT);
  scheduleLogFlush();
}

const META_FILE = (dir: string): string => `${dir}/.novel2vn/image-story.json`;
const CACHE_ROOT = (dir: string): string => `${dir}/.novel2vn/cache`;
const LOG_FILE = (dir: string): string => `${dir}/.novel2vn/image-story.log`;
const FAILED_FILE = (dir: string): string => `${dir}/.novel2vn/image-story-failed.json`;

interface ImageStoryMeta {
  version?: number;
  options?: Partial<ImageStoryOptions>;
  scriptStyle?: string;
  useBgm?: boolean;
  useSe?: boolean;
  useVoice?: boolean; // #1140：配音开关持久化
  dirAuto?: boolean;
  projectKey?: string;
}

/* ---- 运行日志落盘（#1148：关掉应用即丢 → 落盘到图片版目录 .novel2vn 下并可恢复） ---- */

const LOG_FILE_LIMIT = 2000;
const DISPLAY_LOG_LIMIT = 500;
let diskLogEvents: PipelineEvent[] = [];
let logWriteChain: Promise<void> = Promise.resolve();
let logFlushTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleLogFlush(): void {
  if (logFlushTimer !== undefined) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = undefined;
    void flushLogFile();
  }, 800);
}

async function flushLogFile(): Promise<void> {
  const dir = imageStoryState.outputDir;
  if (!dir || !diskLogEvents.length) return;
  const payload = diskLogEvents.map((ev) => JSON.stringify(ev)).join("\n");
  logWriteChain = logWriteChain
    .then(() => tauri.mkdirAll(`${dir}/.novel2vn`))
    .then(() => tauri.writeTextFile(LOG_FILE(dir), payload))
    .catch((e) => logger.warn("imageStory", "图片小说运行日志落盘失败", { error: errMsg(e).slice(0, 160) }));
  await logWriteChain;
}

async function readLogFile(dir: string): Promise<PipelineEvent[]> {
  const out: PipelineEvent[] = [];
  try {
    const { text } = await tauri.readTextFile(LOG_FILE(dir));
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed) as PipelineEvent;
        if (ev && typeof ev.message === "string") out.push({ step: ev.step ?? "运行", message: ev.message, level: ev.level ?? "info", at: ev.at ?? Date.now() });
      } catch {
        /* 跳过损坏行 */
      }
    }
  } catch {
    /* 首次运行没有日志文件 */
  }
  return out.slice(-LOG_FILE_LIMIT);
}

/** 恢复日志：按 dir 合并（#1439：读盘历史 + 本次新条目去重，避免 pushLog-before-sync 后整文件覆写清掉历史） */
async function syncLogsFromDisk(dir: string): Promise<void> {
  const disk = await readLogFile(dir);
  diskLogEvents = mergeImageStoryLogs(disk, diskLogEvents, LOG_FILE_LIMIT);
  imageStoryState.logs = diskLogEvents.slice(-DISPLAY_LOG_LIMIT);
}

/* ---- 失败项落盘（#1148） ---- */

let failedWriteChain: Promise<void> = Promise.resolve();
let failedFlushTimer: ReturnType<typeof setTimeout> | undefined;

async function persistFailedItems(): Promise<void> {
  const dir = imageStoryState.outputDir;
  if (!dir) return;
  const payload = JSON.stringify(imageStoryState.failed, null, 2);
  failedWriteChain = failedWriteChain
    .then(() => tauri.mkdirAll(`${dir}/.novel2vn`))
    .then(() => tauri.writeTextFile(FAILED_FILE(dir), payload))
    .catch((e) => logger.warn("imageStory", "图片小说失败项落盘失败", { error: errMsg(e).slice(0, 160) }));
  await failedWriteChain;
}

async function readFailedFile(dir: string): Promise<ImageStoryFailedItem[]> {
  try {
    const { text } = await tauri.readTextFile(FAILED_FILE(dir));
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is ImageStoryFailedItem =>
        !!f && typeof f === "object" && typeof (f as ImageStoryFailedItem).key === "string" && typeof (f as ImageStoryFailedItem).message === "string",
    );
  } catch {
    return [];
  }
}

function scheduleFailedPersist(): void {
  if (failedFlushTimer !== undefined) return;
  failedFlushTimer = setTimeout(() => {
    failedFlushTimer = undefined;
    void persistFailedItems();
  }, 600);
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;

let saveChain: Promise<void> = Promise.resolve();
function persist(): void {
  const dir = imageStoryState.outputDir;
  if (!dir) return;
  const payload = JSON.stringify(
    {
      version: 2,
      outputDir: dir,
      options: imageStoryState.options,
      scriptStyle: imageStoryState.scriptStyle,
      useBgm: imageStoryState.useBgm,
      useSe: imageStoryState.useSe,
      useVoice: imageStoryState.useVoice, // #1140
      dirAuto: imageStoryState.dirAuto,
      projectKey: imageStoryState.dirProjectKey,
    },
    null,
    2,
  );
  saveChain = saveChain
    .then(() => tauri.mkdirAll(`${dir}/.novel2vn`))
    .then(() => tauri.writeTextFile(META_FILE(dir), payload))
    .catch((e) => logger.warn("imageStory", "图片小说状态保存失败", { error: errMsg(e).slice(0, 200) }));
}

/** 载入独立状态（页面挂载时调用一次）：独立目录/选项记忆，卡与剧本从磁盘恢复 */
export async function loadImageStoryState(): Promise<void> {
  if (imageStoryState.loaded) return;
  imageStoryState.loaded = true;
  let remembered = "";
  try {
    remembered = localStorage.getItem("novelforge:image-story-dir") ?? "";
  } catch {
    /* 忽略 */
  }
  const rememberedMeta = remembered ? await readMeta(remembered) : null;
  // #1101：自动跟随的目录按当前主项目重算（换作品不残留旧书目录）；手动指定的目录保留但标记归属
  const decision = resolveImageStoryDirOnLoad({
    rememberedDir: remembered,
    rememberedAuto: rememberedMeta?.dirAuto !== false,
    derivedDir: defaultImageStoryDir(),
  });
  const meta = decision.dir === remembered ? rememberedMeta : await readMeta(decision.dir);
  imageStoryState.outputDir = decision.dir;
  applyMeta(meta);
  imageStoryState.dirAuto = meta?.dirAuto !== undefined ? meta.dirAuto !== false : decision.auto;
  imageStoryState.dirProjectKey = imageStoryState.dirAuto ? mainProjectKey() : (meta?.projectKey ?? "");
  if (decision.followed && remembered && decision.dir !== remembered) {
    pushLog("项目", `主项目已切换：图片版目录已跟随为 ${decision.dir}（原目录 ${remembered}）`);
  }
  try {
    localStorage.setItem("novelforge:image-story-dir", decision.dir);
  } catch {
    /* 忽略 */
  }
  // #1292：登记图片版输出目录（派生目录，不在项目目录内，不登记则读写一律被拒）
  if (decision.dir) {
    try {
      await tauri.blessProjectDir(decision.dir);
    } catch {
      /* 登记失败不阻断，后续文件命令会给出明确拒绝 */
    }
  }
  await refreshFromDisk();
}

async function readMeta(dir: string): Promise<ImageStoryMeta | null> {
  try {
    const { text } = await tauri.readTextFile(META_FILE(dir));
    return JSON.parse(text) as ImageStoryMeta;
  } catch {
    return null;
  }
}

function applyMeta(meta: ImageStoryMeta | null): void {
  const includeItems = meta?.options?.includeItems === true;
  // #1099：图片小说模式不展示物品图（渲染端跳过、鉴赏室不收录），开关强制关闭，避免付费后看不到
  imageStoryState.options = { ...DEFAULT_OPTIONS, ...(meta?.options ?? {}), includeItems: false };
  imageStoryState.scriptStyle = typeof meta?.scriptStyle === "string" ? meta.scriptStyle : "";
  imageStoryState.useBgm = meta?.useBgm !== false;
  imageStoryState.useSe = meta?.useSe !== false;
  imageStoryState.useVoice = meta?.useVoice === true; // #1140：默认关，显式开过才开
  if (includeItems) pushLog("物品图", t("图片小说模式不展示物品图，已关闭「生成物品图」开关（避免付费后游戏内看不到）"), "warn");
}

/** 从磁盘恢复卡片/剧本/图片映射/日志/失败项（换目录或生成结束后调用） */
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
  imageStoryState.failed = await readFailedFile(dir);
  await syncLogsFromDisk(dir);
  refreshPlan();
}

export function setImageStoryDir(dir: string, opts: { manual?: boolean } = {}): void {
  const next = (dir || "").trim();
  if (!next) return;
  // #1322：运行中锁输出目录（对齐主链路 ProjectBar locked 口径）——阶段间 dir 是入口快照，
  // 中途换目录会让产物分裂在两个目录且 refreshFromDisk 立即覆盖卡片/剧本显示。
  if (imageStoryState.running) {
    pushLog("项目", t("运行中不允许切换输出目录：请等待本次运行结束或先停止"), "warn");
    return;
  }
  if (opts.manual !== false) {
    // 手动指定：不再自动跟随，并把目录绑定到当前主项目（之后换作品会提示「目录属于其他作品」）
    imageStoryState.dirAuto = false;
    imageStoryState.dirProjectKey = mainProjectKey();
  }
  if (next === imageStoryState.outputDir) return;
  imageStoryState.outputDir = next;
  // #1292：登记新目录（用户明示切换），否则后续读写被白名单拒绝
  void tauri.blessProjectDir(next).catch(() => undefined);
  // 目录变了：旧预览地址不再对应当前产物，日志缓冲也属于旧目录
  imageStoryState.previewUrl = "";
  imageStoryState.previewRunning = false;
  diskLogEvents = [];
  try {
    localStorage.setItem("novelforge:image-story-dir", next);
  } catch {
    /* 忽略 */
  }
  void persist();
  void refreshFromDisk();
}

/** 按当前作品重算目录（#1101）：页面「按当前作品重算目录」按钮与主项目切换时自动跟随共用 */
export function followMainProjectDir(): void {
  imageStoryState.dirAuto = true;
  imageStoryState.dirProjectKey = mainProjectKey();
  setImageStoryDir(defaultImageStoryDir(), { manual: false });
}

watch(
  () => JSON.stringify([imageStoryState.options, imageStoryState.scriptStyle, imageStoryState.useBgm, imageStoryState.useSe, imageStoryState.useVoice]), // #1140：配音开关加入持久化监听
  () => {
    refreshPlan();
    // #1103：每键入即写盘 → 防抖 500ms，连续调参只落盘一次
    if (persistTimer !== undefined) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      persist();
    }, 500);
  },
);

watch(
  () => JSON.stringify(imageStoryState.failed),
  () => scheduleFailedPersist(),
);

// #1101：主项目切换时，自动跟随的目录立刻重算；手动目录保持不动（由页面提示「属于其他作品」）
// #1322：运行中不跟随（setImageStoryDir 本来也会拒绝，这里提前跳过，避免运行中途换目录分裂产物）
watch(mainProjectKey, (key) => {
  if (!imageStoryState.loaded) return;
  if (!imageStoryState.dirAuto) return;
  if (imageStoryState.running) return;
  imageStoryState.dirProjectKey = key;
  const next = defaultImageStoryDir();
  if (next && next !== imageStoryState.outputDir) {
    pushLog("项目", `主项目已切换：图片版目录跟随为 ${next}`);
    setImageStoryDir(next, { manual: false });
  }
});

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

/** 预估：尚无剧本时按「章节数 × 4 场景 × 每场景张数（默认 2）」粗估，供生成前提示（#1103：不限张数时文案须说明是粗估） */
export const imageStoryEstimate = computed(() => {
  const plan = imageStoryState.plan;
  if (plan) {
    return { total: plan.total, yuan: plan.yuan, exact: true, unbounded: false };
  }
  return estimateImageStoryPlan(
    enabledChapters.value.length,
    imageStoryState.options,
    imageStoryState.cards?.characters.length ?? 0,
  );
});

/* ==================== 读取/缓存 ==================== */

/** 剧本缓存指纹（#1098/#1341）：剧本文风 + 视觉模式 + 卡片指纹——卡片重提导致 id 变化时旧剧本必须失效，
 * 否则渲染按新卡查 id 失败会退化成旁白/内部 id（与主管线 cardsFpForScript 同口径）。 */
const scriptFp = (cards?: Pick<ExtractionResult, "characters" | "items" | "scenes"> | null): string =>
  scriptFingerprint({
    style: imageStoryState.scriptStyle,
    compressNarration: false,
    visualMode: "imageOnly",
    cardsFp: cards ? cardsFingerprint(cards) : undefined,
  });

/** #1134：分镜触发行号兜底（缺失/重复/非递增 → 按剧情均匀铺开）；有修正时写回缓存，保证游戏内演出与缓存一致 */
async function repairShotTriggers(script: ChapterScript, cacheFile: string): Promise<ChapterScript> {
  const { chapters, repairs } = normalizeShotTriggers([script]);
  if (!repairs.length) return script;
  const fixed = chapters[0];
  for (const r of repairs) {
    pushLog(
      "剧本",
      `第 ${fixed.chapter + 1} 章场景 ${r.sceneId}：${r.before.length} 张分镜的触发行号缺失/重复/非递增，已按剧情均匀铺开（${r.before.join("/")} → ${r.after.join("/")}）`,
      "warn",
    );
  }
  try {
    await tauri.writeTextFile(cacheFile, JSON.stringify(fixed, null, 2));
  } catch {
    /* 写回失败不影响本次运行 */
  }
  return fixed;
}

async function readCachedChapters(): Promise<ChapterScript[]> {
  const dir = imageStoryState.outputDir;
  const chapters = enabledChapters.value;
  if (!dir || !chapters.length) return [];
  // #1341：用内存卡片算 cardsFp（换书/改卡后旧剧本缓存自然失效一次）；无卡片时退化为旧口径。
  const fp = scriptFp(imageStoryState.cards);
  const cacheDir = CACHE_ROOT(dir);
  const out: ChapterScript[] = [];
  // #1435：载入期禁止付费翻译，未命中翻译缓存时降级原文（effectiveChapterText 内部直接返回原文）
  const lang = (imageStoryState.options.language ?? "").trim();
  let fallbackCount = 0;
  for (const ch of chapters) {
    const eff = await effectiveChapterText(ch, { allowPaidTranslate: false });
    if (lang && eff.text === ch.text) {
      // 原文直通可能是「本就不用翻译」也可能是「缓存缺失降级」；仅在设置了语言时计数，
      // 最终统一 warn 一次（避免每章一条刷屏），计费翻译只在 run 阶段发起。
      fallbackCount++;
    }
    const file = scriptCacheFileName(cacheDir, false, ch.index, eff.title, eff.text, fp);
    try {
      const { text } = await tauri.readTextFile(file);
      const script = parseChapterScript(JSON.parse(text));
      out.push(await repairShotTriggers(script, file));
    } catch {
      /* 未生成 */
    }
  }
  if (lang && fallbackCount > 0) {
    pushLog("翻译", t("载入期未自动翻译（{n} 章暂用原文）：如需翻译请点「开始生成」在运行阶段生成（复用主项目翻译缓存）", { n: fallbackCount }), "warn");
  }
  return out.sort((a, b) => a.chapter - b.chapter);
}

/** 翻译复用：优先读主项目的翻译缓存（同一本小说只翻一次），否则按需翻译
 *  #1435：载入/refresh 路径禁止付费翻译（allowPaidTranslate=false 时缓存未命中直接降级原文），
 *  只有 run 阶段（runScriptStage）允许发起付费翻译，避免打开页面即全书扣费。 */
async function effectiveChapterText(
  ch: ChapterInfo,
  opts: { allowPaidTranslate?: boolean } = {},
): Promise<{ title: string; text: string }> {
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
  // #1435：载入期直接降级原文（不发起付费 LLM 翻译、不注册中止，调用方统一 warn 一次）
  if (!opts.allowPaidTranslate) return { title: ch.title, text: ch.text };
  const llm = activeConfig("llm");
  if (!llm?.apiKey) return { title: ch.title, text: ch.text };
  try {
    const translated = await translateChapter(llm, ch, lang, undefined, undefined);
    await tauri.mkdirAll(`${imageStoryState.outputDir}/.novel2vn/translate`);
    await tauri.writeTextFile(ownFile, JSON.stringify(translated, null, 2));
    pushLog("翻译", `第 ${ch.index + 1} 章翻译完成（${lang}，已写入翻译缓存）`, "success");
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
  // #1319：走按次注册表（与主管线同槽位但按 runId 隔离），仅持有者可注销——
  // 并发时结束一方不再误清另一方的在途可取消性；register 内部仍同步兼容旧 active 快照。
  registerRunAbort("imageStory", imageStoryAbort.signal);
}

function endAbortableRun(): void {
  // #1319：仅注销自己的注册（非持有者调用直接忽略），替代此前"比对 active 再清"的手工 dance。
  unregisterRunAbort("imageStory", imageStoryAbort.signal);
}

/** #1319：图片小说运行态按来源同步全局（侧栏指示/停止入口/导入守卫可见）。
 *  与主管线各写各的槽（忙=或），并发时一方结束不误清另一方。 */
function syncImageStoryRunStatus(): void {
  try {
    runStatusSyncSource(
      "image",
      imageStoryState.running,
      imageStoryState.running ? "图片小说" : "",
      false,
      imageStoryState.stopping,
    );
  } catch {
    /* 全局状态同步失败不影响本次运行 */
  }
}

/** #1321：三个入口共用的收尾——stopping/stage/progress 复位 + 持久化（缺一则重试/单张重生成后停止按钮变“正在停止…”且无法再停）。 */
function endImageStoryRun(): void {
  imageStoryState.running = false;
  imageStoryState.stopping = false;
  imageStoryState.stage = "";
  imageStoryState.progress = null;
  endAbortableRun();
  syncImageStoryRunStatus();
  persist();
}

watch(
  () => [imageStoryState.running, imageStoryState.stopping] as const,
  () => syncImageStoryRunStatus(),
);

export function stopImageStory(): void {
  if (!imageStoryState.running) return;
  abortFlag = true;
  imageStoryAbort.abort();
  imageStoryState.stopping = true;
  syncImageStoryRunStatus();
  pushLog("运行", "已请求停止：不再派发新的付费请求，在途请求已中断", "warn");
}

// #1319：注册图片小说停止入口——侧栏全局停止会同时停主管线与图片小说（各停各的控制器）。
// stopImageStory 是 idle-safe（未运行时直接返回），可放心常驻注册。
registerRunStopSource("image", () => stopImageStory());

async function ensureOutputDir(): Promise<void> {
  const dir = imageStoryState.outputDir;
  await tauri.mkdirAll(`${dir}/.novel2vn/cache`);
  persist();
}

async function runExtractStage(llm: NonNullable<ReturnType<typeof activeConfig>>): Promise<ExtractionResult> {
  const dir = imageStoryState.outputDir;
  const cardsFile = `${dir}/.novel2vn/cards.json`;
  // #1339：卡片缓存必须校验小说指纹（与主管线 novelFp 同口径：源路径 + 各章正文哈希），
  // 否则换书后命中旧书卡片，用 B 的正文 + A 的角色卡生成分镜（错内容 + 白花钱）。
  const novel = projectState.novel!;
  const novelFp = `${novel.fileName}:${titleHash((novel.chapters ?? []).map((c) => c.text || "").join(""))}`;
  try {
    const { text } = await tauri.readTextFile(cardsFile);
    const parsed = JSON.parse(text) as ExtractionResult & { _novelFp?: string };
    if (Array.isArray(parsed.characters)) {
      if (parsed._novelFp && parsed._novelFp !== novelFp) {
        pushLog("提取", "检测到小说内容变化（或更换了小说），旧卡片缓存已作废，正在重新提取…", "warn");
      } else {
        pushLog("提取", `卡片缓存命中：${parsed.characters.length} 角色 / ${parsed.scenes?.length ?? 0} 场景 / ${parsed.items?.length ?? 0} 物品`);
        return parsed;
      }
    }
  } catch {
    /* 首次提取 */
  }
  pushLog("提取", `开始提取卡片（${Math.round(novel.fullText.length / 1000)}k 字，按上下文分段扫描）…`);
  const result = await extractFromNovelChunked(llm, novel.fullText, novel.fileName.replace(/\.txt$/i, ""), {
    log: (message, level = "info") => pushLog("提取", message, level),
    isAborted: () => abortFlag,
    voiceLib: voiceLibraryFor(activeConfig("tts")),
  });
  await tauri.writeTextFile(cardsFile, JSON.stringify({ ...result, _novelFp: novelFp }, null, 2));
  pushLog("提取", `卡片完成：${result.characters.length} 角色 / ${result.scenes.length} 场景 / ${result.items.length} 物品`, "success");
  return result;
}

async function runScriptStage(llm: NonNullable<ReturnType<typeof activeConfig>>, cards: ExtractionResult): Promise<ChapterScript[]> {
  const dir = imageStoryState.outputDir;
  const cacheDir = CACHE_ROOT(dir);
  // #1341：剧本缓存键带 cardsFp——卡片重提后 id/名称变化时旧剧本自动失效。
  const fp = scriptFp(cards);
  const out: ChapterScript[] = [];
  const chapters = enabledChapters.value;
  for (let i = 0; i < chapters.length; i++) {
    if (abortFlag) break;
    const ch = chapters[i];
    // #1435：只有 run 阶段允许付费翻译（载入期已禁止），带阶段/进度/停止能力
    const eff = await effectiveChapterText(ch, { allowPaidTranslate: true });
    imageStoryState.stage = "剧本";
    imageStoryState.progress = { done: i, total: chapters.length };
    const file = scriptCacheFileName(cacheDir, false, ch.index, eff.title, eff.text, fp);
    try {
      const { text } = await tauri.readTextFile(file);
      out.push(await repairShotTriggers(parseChapterScript(JSON.parse(text)), file));
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
        onLog: (message) => pushLog("剧本", message),
        onPart: ({ part, total, phase, elapsedMs }) => {
          if (total <= 1) return;
          if (phase === "start" && part === 1) {
            pushLog("剧本", `第 ${ch.index + 1} 章较长，将分 ${total} 部分逐段生成（每部分约 1–3 分钟）…`);
          } else if (phase === "done") {
            pushLog("剧本", `第 ${ch.index + 1} 章第 ${part}/${total} 部分完成（${Math.round(elapsedMs / 1000)}s）`);
          }
        },
      });
      await tauri.mkdirAll(cacheDir);
      await tauri.writeTextFile(file, JSON.stringify(script, null, 2));
      out.push(await repairShotTriggers(script, file));
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
  // #1099：物品图在图片小说模式不参与演出也不进鉴赏室，开关已被强制关闭；历史配置残留时明确告警
  if (imageStoryState.options.includeItems) pushLog("图片", "「生成物品图」在图片小说模式不生效，已跳过物品图生成", "warn");
  const plan = buildImageStoryPlan(chapters, cards, imageStoryState.options);
  if (!plan.tasks.length) {
    pushLog("图片", "没有可生成的分镜任务（请先完成剧本，或提高张数上限）", "warn");
    return;
  }
  // #1100/#1342：图像并发取该 API 配置并封顶 8（与主管线 pipeline 同公式，避免 429）。
  const concurrency = Math.min(8, concurrencyFor(imageCfg, "image"));
  imageStoryState.plan = { shots: plan.shotCount, threeviews: plan.threeviewCount, items: plan.itemCount, total: plan.tasks.length, yuan: plan.estimatedYuan };
  pushLog("图片", `开始生成图片：分镜 ${plan.shotCount} 张 / 三视图 ${plan.threeviewCount} 张（预计最多 ¥${plan.estimatedYuan}，命中缓存不重复计费；并发 ${concurrency}，取自该图像 API 配置）`);
  const assets = await readAssetMap(dir);
  await backupAssetMap(dir).catch(() => null);
  let done = 0;
  const result = await runImageStoryTasks({
    cfg: imageCfg,
    tasks: plan.tasks,
    cacheRoot: CACHE_ROOT(dir),
    outputDir: dir,
    concurrency,
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
  // #1437：停止后不再打「图片完成 0 张」假成功（runOne 中断未派发的不计失败，中途停应走停止分支）
  if (abortFlag) {
    pushLog("图片", t("图片生成已停止（已完成的产物与缓存保留）"), "warn");
    return;
  }
  pushLog("图片", `图片完成：产出 ${result.produced} 张，失败 ${result.failed} 张`, result.failed ? "warn" : "success");
}

/* ==================== 配音阶段（#1140：复用主管线 TTS 管线，按台词行出音频进 assets.vocal） ==================== */

/** 图片小说配音阶段：开关默认关；开启时按台词行合成（缓存命中不重复计费）。
 * 产物合并进 assets.vocal（组装时自动拷入 game/vocal，渲染侧 imageOnly 已支持 vocal 查表），
 * 失败逐句进失败清单（key `vocal_<台词key>`），可用「重试失败项」补配。 */
async function runImageStoryVoiceStage(cards: ExtractionResult, chapters: ChapterScript[]): Promise<void> {
  const dir = imageStoryState.outputDir;
  const ttsCfg = activeConfig("tts");
  imageStoryState.stage = "配音";
  if (!ttsCfg?.apiKey) {
    const msg = t("配音已开启但未配置 TTS API：已跳过配音（配置后可用「重试失败项」补配）");
    pushLog("配音", msg, "warn");
    imageStoryState.failed.push({ key: "voice_config", label: t("配音配置缺失"), message: msg });
    imageStoryState.stage = "";
    return;
  }
  let expected = 0;
  try {
    // 预检：音色库为空时 buildVoiceJobs 直接抛可读错误（#1139），转失败项而不打断运行
    expected = buildVoiceJobs(ttsCfg, chapters, cards.characters).length;
  } catch (e) {
    const msg = errMsg(e).slice(0, 300);
    pushLog("配音", `配音无法开始：${msg}`, "error");
    imageStoryState.failed.push({ key: "voice_stage", label: t("配音音色库为空"), message: msg });
    imageStoryState.stage = "";
    return;
  }
  if (!expected) {
    pushLog("配音", "当前剧本没有可配音的台词，已跳过配音", "warn");
    imageStoryState.stage = "";
    return;
  }
  pushLog("配音", `开始生成配音：${expected} 句（命中缓存不重复计费）…`);
  const { vocal, failed } = await generateVoice(
    ttsCfg,
    chapters,
    cards.characters,
    CACHE_ROOT(dir),
    (ev) => {
      if (ev.progress) imageStoryState.progress = { done: ev.progress.done, total: ev.progress.total };
      pushLog(ev.step || "配音", ev.message, ev.level);
    },
    concurrencyFor(ttsCfg, "tts"),
    false,
    () => abortFlag,
  );
  imageStoryState.progress = null;
  const previous = await readAssetMap(dir).catch(() => emptyAssetMap());
  const merged = { ...previous.vocal, ...vocal };
  const removed = pruneStaleImageStoryVocal(merged, chapters);
  await updateAssetMap(dir, (map) => {
    map.vocal = merged;
  }).catch(() => undefined);
  imageStoryState.assets = await readAssetMap(dir).catch(() => imageStoryState.assets);
  for (const f of failed) imageStoryState.failed.push(toImageStoryVoiceFailedItem(f));
  imageStoryState.stage = "";
  pushLog(
    "配音",
    `配音完成：本次产出/复用 ${Object.keys(vocal).length}/${expected} 句${failed.length ? `，失败 ${failed.length} 句（已进失败清单，可重试补配）` : ""}${removed.length ? `，清理过期映射 ${removed.length} 项` : ""}`,
    failed.length ? "warn" : "success",
  );
}

async function runAssembleStage(cards: ExtractionResult, chapters: ChapterScript[]): Promise<boolean> {
  const dir = imageStoryState.outputDir;
  imageStoryState.stage = "组装";
  // #1111/#1132：组装前校验「本次剧本覆盖全部启用章节」——缺章会让场景链断裂
  // （chN 末尾 changeScene:chN+1.txt 指向不存在的文件，开局/中途黑屏卡住），因此直接阻断组装。
  const continuity = planChapterContinuity(chapters, enabledChapters.value.map((c) => c.index));
  if (!continuity.ok) {
    const labels = continuity.missing.map((i) => `第 ${i + 1} 章`).join("、");
    const msg = `组装已中止：缺少 ${continuity.missing.length} 个启用章节的分镜剧本（${labels}）。缺章会让游戏场景链断裂（chN 指向不存在的 chN+1），请先「重试失败项」补齐剧本，或关闭这些章节后再组装。`;
    pushLog("组装", msg, "error");
    imageStoryState.lastError = msg;
    for (const i of continuity.missing) {
      imageStoryState.failed.push({
        key: `script_ch${i + 1}`,
        label: `第 ${i + 1} 章剧本`,
        message: "分镜剧本缺失：已阻止组装（避免产物断链）",
      });
    }
    await persistFailedItems();
    return false;
  }
  // #1132：按启用顺序重编号为 ch1..chN（与主链路 pipeline 同口径），停用中间章不再留下空洞
  const ordered = continuity.renumbered;
  if (continuity.present.some((c, i) => c !== i)) {
    pushLog("组装", `章节已按启用顺序重编号：ch1..ch${ordered.length}（停用章不留空洞，原始章号 ${continuity.present.map((c) => c + 1).join("/")}）`);
  }
  const templateDir = await resolveTemplateDir();
  const assets = await readAssetMap(dir);
  // #1436：一张图都没有（无图像 API / 全失败 / 空计划）时阻断组装，避免零 changeBg 成品报 success
  const shotCount = Object.keys(assets.shot ?? {}).length;
  if (shouldBlockAssembleOnZeroShots(imageStoryState.produced, shotCount)) {
    const msg = t("组装已中止：没有可用的分镜图片（0 张），成品将全程无画面。请先配置图像 API 并生成图片后再组装");
    pushLog("组装", msg, "error");
    imageStoryState.lastError = msg;
    return false;
  }
  const title = (projectState.novel?.fileName ?? "图片小说").replace(/\.txt$/i, "");
  const sample = ordered
    .slice(0, 3)
    .map((c) => `${c.title} ${c.scenes.map((s) => s.location).join(" ")}`)
    .join(" ");
  // #1104：模板缺少内置 SE（game/vocal 无 wav）时降级为不输出 playEffect，避免成品 404 静默无声
  let useSe = imageStoryState.useSe;
  if (useSe) {
    const seDir = `${templateDir}/game/vocal`;
    const entries = await tauri.listDir(seDir).catch(() => []);
    const hasSe = entries.some((e) => !e.isDir && e.name.toLowerCase().endsWith(".wav"));
    if (!hasSe) {
      useSe = false;
      pushLog("组装", `模板缺少内置环境音效（${seDir} 无 wav 文件）：已自动关闭环境音效，避免产物播放 404 静默无声`, "warn");
    }
  }
  await tauri.mkdirAll(`${dir}/.novel2vn`);
  await assembleProject({
    outputDir: dir,
    title,
    gameKey: gameKeyFor(title),
    templateDir,
    chapters: ordered,
    cards,
    assets,
    mode: "imageOnly",
    introCard: false,
    figureEmotions: false,
    figureActions: false,
    useBgm: imageStoryState.useBgm,
    useSe,
    language: inferWebgalLanguage(sample || title),
    log: (message) => pushLog("组装", message),
  });
  pushLog(
    "组装",
    `组装完成：${ordered.length} 章（ch1..ch${ordered.length}）${imageStoryState.useBgm ? "" : "，未启用 BGM"}${useSe ? "" : "，未启用环境音效"}（可预览或导出 zip）`,
    "success",
  );
  return true;
}

/** 一键运行：提取 → 分镜剧本 → 图片 → 组装（复用缓存，只补缺失） */
export async function runImageStory(): Promise<void> {
  if (imageStoryState.running) return;
  // #1319：图片小说与主管线共享 LLM/图像配额与全局中止单槽——主管线运行中不再并行启动第二套付费管线。
  if (runIsBusy.value) {
    const msg = t("主管线正在运行：请等待其结束或先停止，再启动图片小说（避免两套付费管线并发）");
    imageStoryState.lastError = msg;
    pushLog("运行", msg, "warn");
    return;
  }
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
  // #1436：无图像 API 时前置预警（与缺 LLM 同口径提示位置）：仍允许跑提取/剧本，但明确组装会被零图门禁阻断
  if (!activeConfig("image")?.apiKey) {
    pushLog("图片", t("未配置图像 API：本次仍会生成提取与剧本，但图片阶段将跳过、组装会被阻断（成品无画面）"), "warn");
  }
  abortFlag = false;
  beginAbortableRun();
  imageStoryState.running = true;
  imageStoryState.stopping = false;
  imageStoryState.failed = [];
  imageStoryState.produced = 0;
  imageStoryState.lastError = "";
  syncImageStoryRunStatus();
  // #1148：日志不再整段清空——运行日志落盘并可恢复，这里只插入分节标记（历史仍在 .novel2vn/image-story.log）
  pushLog("运行", `—— 新一轮运行（输出目录：${imageStoryState.outputDir}）——`);
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
    // #1140：配音阶段（默认关闭；开启时复用主管线 TTS 管线按台词行出音频，产物进 assets.vocal 供组装引用）
    if (!abortFlag && chapters.length && imageStoryState.useVoice) await runImageStoryVoiceStage(cards, chapters);
    let assembled = false;
    if (!abortFlag && chapters.length) assembled = await runAssembleStage(cards, chapters);
    if (abortFlag) pushLog("运行", "已停止（已完成的产物与缓存保留）", "warn");
    else if (!chapters.length) pushLog("运行", "没有生成任何章节的分镜剧本：已跳过组装（见上方失败项）", "warn");
    // #1436：组装失败可能是缺章也可能是零图，不再写死「缺章」，以上方具体错误为准
    else if (!assembled) pushLog("运行", `运行结束：分镜剧本 ${chapters.length} 章，图片产出 ${imageStoryState.produced} 张；组装未完成（见上方错误）`, "warn");
    else pushLog("运行", `全部完成：分镜剧本 ${chapters.length} 章，图片产出 ${imageStoryState.produced} 张`, "success");
    await refreshFromDisk();
  } catch (e) {
    imageStoryState.lastError = errMsg(e).slice(0, 400);
    pushLog("运行", `运行失败：${imageStoryState.lastError}`, "error");
  } finally {
    // #1321：收尾统一走 endImageStoryRun（stopping/stage/progress 复位 + persist + 全局状态同步）。
    endImageStoryRun();
    // #1148：运行结束把失败项与日志强制落盘（防抖窗口内的改动也不丢）
    await persistFailedItems();
    await flushLogFile();
  }
}

/** 重试失败项：先补齐缺剧本的章节，再复用缓存重跑图片阶段（已完成的不会重复计费）并重新组装 */
export async function retryFailedImages(): Promise<void> {
  if (imageStoryState.running) return;
  // #1319：同 runImageStory，主管线运行中不并行启动。
  if (runIsBusy.value) {
    const msg = t("主管线正在运行：请等待其结束或先停止，再重试图片小说失败项");
    imageStoryState.lastError = msg;
    pushLog("运行", msg, "warn");
    return;
  }
  const cards = imageStoryState.cards;
  if (!cards) return;
  const llm = activeConfig("llm");
  if (!llm?.apiKey) {
    imageStoryState.lastError = t("请先在「API 配置」页配置文本 LLM（分镜剧本需要）");
    return;
  }
  imageStoryState.running = true;
  // #1321：复位 stopping/stage/progress/lastError（与 runImageStory 同口径），否则上次停止残留会导致本次停止按钮变“正在停止…”且被禁用。
  imageStoryState.stopping = false;
  imageStoryState.stage = "";
  imageStoryState.progress = null;
  imageStoryState.lastError = "";
  syncImageStoryRunStatus();
  abortFlag = false;
  beginAbortableRun();
  imageStoryState.failed = [];
  try {
    const chapters = await runScriptStage(llm, cards);
    imageStoryState.chapters = chapters;
    refreshPlan();
    // #1437：补 runImageStory 同款 abortFlag 门（停止后不跑图片/组装、不追加缺章假失败项）
    if (shouldRunPostScriptStages(abortFlag, chapters.length)) {
      await runImageStage(cards, chapters);
      // #1140：重试同样补配音（generateVoice 内部缓存命中跳过，只补缺失；失败进失败清单）
      if (!abortFlag && chapters.length && imageStoryState.useVoice) await runImageStoryVoiceStage(cards, chapters);
    }
    if (shouldRunPostScriptStages(abortFlag, chapters.length)) {
      await runAssembleStage(cards, chapters);
    }
    if (abortFlag) pushLog("运行", "已停止（已完成的产物与缓存保留）", "warn");
    await refreshFromDisk();
  } catch (e) {
    imageStoryState.lastError = errMsg(e).slice(0, 400);
  } finally {
    endImageStoryRun();
    await persistFailedItems();
    await flushLogFile();
  }
}

/** 单张分镜重生成（强制覆盖该张；依赖的三视图走缓存） */
export async function regenerateShot(taskId: string): Promise<void> {
  if (imageStoryState.running) return;
  const cards = imageStoryState.cards;
  const chapters = imageStoryState.chapters;
  const dir = imageStoryState.outputDir;
  const imageCfg = activeConfig("image");
  // #1404：三处前置静默 return 改为 pushLog + lastError（页面已有 lastError 展示行），点击有反馈
  if (!cards || !chapters.length) {
    const msg = t("没有可重生成的分镜：请先完成提取与剧本");
    imageStoryState.lastError = msg;
    pushLog("图片", msg, "warn");
    return;
  }
  if (!imageCfg?.apiKey) {
    const msg = t("未配置图像 API：请先在「API 配置」页配置图像 API 后再重生成");
    imageStoryState.lastError = msg;
    pushLog("图片", msg, "warn");
    return;
  }
  const plan = buildImageStoryPlan(chapters, cards, imageStoryState.options);
  const task = plan.tasks.find((t) => t.kind === "shot" && t.id === taskId);
  if (!task) {
    const msg = t("该分镜不在当前张数设置内：请恢复每场景/每章/总张数上限后再重生成");
    imageStoryState.lastError = msg;
    pushLog("图片", msg, "warn");
    return;
  }
  const assets = await readAssetMap(dir);
  const figureBase: Record<string, string> = {};
  for (const [id, path] of Object.entries(assets.figure)) figureBase[id] = path;
  // 依赖的三视图缺失时不单张重生成（避免静默降级为纯文生图导致人物不一致）
  // #1133：多人分镜对每个出场角色都校验，不再只看第一个角色
  const missingChars = shotCharacterIdsOf(task).filter((id) => !figureBase[`${id}_threeview`]);
  if (missingChars.length) {
    pushLog("图片", `角色 ${missingChars.join("、")} 的三视图缺失：请先重跑图片阶段补齐三视图后再重生成该分镜`, "error");
    return;
  }
  imageStoryState.running = true;
  // #1321：同 retry，复位停止/阶段/进度态，避免残留 stopping 导致本次无法停止。
  imageStoryState.stopping = false;
  imageStoryState.stage = "";
  imageStoryState.progress = null;
  syncImageStoryRunStatus();
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
      // 单张重生成不跑三视图任务：把已生成的三视图作为预置参考传入（#1133 多身份参考同样受益）
      figureBase,
      log: (ev) => pushLog(ev.step || "图片", ev.message, ev.level),
      verifyCfg: imageStoryState.options.imageSelfCheck ? activeConfig("vision") : undefined,
      // #1370：与批量图片阶段同口径——补 visionCfg（参考图描述缓存）与 safeRewriteCfg（策略拒绝后安全改写），否则单张比批量更容易失败/漂移。
      visionCfg: activeConfig("vision"),
      safeRewriteCfg: activeConfig("llm"),
      onTaskDone: (t2, path) => {
        void updateAssetMap(dir, (map) => {
          map.shot = { ...(map.shot ?? {}), [t2.id]: path };
        }).catch(() => undefined);
      },
      onTaskFailed: (t2, message) => {
        pushLog("图片", `${t2.usage || t2.id} 重生成失败：${message.slice(0, 160)}`, "error");
        imageStoryState.failed.push({ key: t2.id, label: t2.usage || t2.fileName, message });
      },
    });
    await refreshFromDisk();
  } finally {
    endImageStoryRun();
    await persistFailedItems();
    await flushLogFile();
  }
}

/* ==================== 预览与导出 ==================== */

export async function startImageStoryPreview(): Promise<void> {
  const dir = imageStoryState.outputDir;
  if (!dir) return;
  try {
    // #1323：经共享持有者接管（先停旧服务，可能是主项目预览）；成功才记名，失败不碰持有状态
    const url = await claimPreview("imageStory", dir);
    imageStoryState.previewUrl = url;
    imageStoryState.previewRunning = true;
    pushLog("预览", `预览已启动：${url}`, "success");
  } catch (e) {
    imageStoryState.previewUrl = "";
    imageStoryState.previewRunning = false;
    pushLog("预览", `预览启动失败：${errMsg(e).slice(0, 160)}`, "error");
  }
}

/** 停止共享预览服务器并复位状态（#1102）：停服后不再显示「预览已启动」，避免状态与实际不符。
 *  #1323：只停自己持有的——服务已被主项目预览接管时，只清本地假状态，不杀别人的服务。 */
export async function stopImageStoryPreview(): Promise<void> {
  const owned = previewOwner() === "imageStory";
  try {
    if (owned) await releasePreview("imageStory");
    if (owned) pushLog("预览", "预览已停止");
  } catch (e) {
    pushLog("预览", `停止预览失败：${errMsg(e).slice(0, 160)}`, "warn");
  }
  imageStoryState.previewUrl = "";
  imageStoryState.previewRunning = false;
}

/** #1323：预览服务器被另一页接管时调用——清掉本页的"已启动"假状态并记日志（服务已换根）。 */
export function notifyPreviewTaken(by: string): void {
  if (!imageStoryState.previewRunning && !imageStoryState.previewUrl) return;
  imageStoryState.previewRunning = false;
  imageStoryState.previewUrl = "";
  pushLog("预览", `预览服务器已被${by}接管，本页预览状态已复位`, "warn");
}

/** #1323：给 previewUrl 一个真正的打开入口（此前只有一个"已启动"标签，点不开任何东西） */
export async function openImageStoryPreviewInBrowser(): Promise<void> {
  const url = imageStoryState.previewUrl;
  if (!url) return;
  try {
    await tauri.openUrl(url);
  } catch (e) {
    pushLog("预览", `打开失败：${errMsg(e).slice(0, 160)}`, "error");
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
    // #1434：复用主路径 #1116 守卫——目标在项目目录内会把正在写入的 zip 半成品打进包里
    if (isPathInsideDir(dir, target)) {
      const msg = t("保存位置不能在项目目录内部（否则会把正在写入的 zip 自身打进包里）：请换一个目录");
      pushLog("导出", msg, "error");
      imageStoryState.lastError = msg;
      return;
    }
    // #1292：登记保存位置所在目录（用户经保存对话框明示授权），否则写 zip 被白名单拒绝
    await blessParentDir(target);
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

/** #1374：剧本里有、assets 里缺的分镜（失败/中断/刷新后）：网格给占位 + 补跑入口，避免“无痕缺失”。 */
export const imageStoryMissingShots = computed(() => {
  const assets = imageStoryState.assets;
  const out: { id: string; chapter: number; title: string; note: string }[] = [];
  for (const script of imageStoryState.chapters) {
    for (const scene of script.scenes) {
      for (const s of scene.shots ?? []) {
        if (!assets.shot?.[s.id]) out.push({ id: s.id, chapter: script.chapter, title: script.title, note: s.note || scene.location });
      }
    }
  }
  return out.sort((a, b) => a.chapter - b.chapter);
});

export function goImport(): void {
  goPage("import");
}
