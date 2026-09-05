<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { t } from "../i18n";
import { open } from "@tauri-apps/plugin-dialog";
import { projectState, pushLog, clearLogs, scheduleSave, restoreProject, flushPendingProjectSave, getStageLastLevels, getLastActiveStage } from "../stores/project";
import { activeConfig, configState, addRecentOutputDir } from "../stores/config";
import { Pipeline, novelFingerprint, joinAppendText } from "../core/pipeline";
import type { SplitMethod } from "../core/pipeline";
import { resolveTemplateDir } from "../utils/template";
import { tauri, isTauri } from "../utils/tauri";
import { vfsWriteFileBase64 } from "../utils/vfsWeb";
import { sanitizeId } from "../core/render";
import { errMsg } from "../utils/errors";
import { ERROR_CLASS_ICON, ERROR_CLASS_LABEL, classifyError } from "../utils/errorClassifier";
import { cutoutErrorHint } from "../utils/cutoutErrorHint";
import { log as logger, dumpLogHistory } from "../utils/logger";
import EditCards from "../components/EditCards.vue";
import PageHead from "../components/PageHead.vue";
import StepIndicator from "../components/StepIndicator.vue";
import StageStatusBoard from "../components/StageStatusBoard.vue";
import ChapterStatusBoard from "../components/ChapterStatusBoard.vue";
import { useStageStatus } from "../composables/useStageStatus";
import { useChapterStatus, isChapterContentComplete, emptyChapterLight } from "../composables/useChapterStatus";
import type { AssetMap, FailedTask, ImageTask, PipelineEvent, StageFeedback, StageKey, VideoSuggestion } from "../core/types";
import { STAGE_LABELS, STAGE_ORDER, LANGUAGES } from "../core/types";
import {
  regenerateCharacterFigures,
  regenerateCharacterThreeView,
  imageTaskMatchesSelectionKey,
  imageTaskIdentity,
  regenerateCharacterAction,
  regenerateItemImage,
  regenerateBackground,
  regenerateCg,
  regenerateVoiceLine,
  regenerateCharacterVoice,
  regenerateImages,
  type RegenContext,
} from "../core/regenerate";
import { reCutoutAsset, buildImageTasks, repairImageAssets } from "../core/images";
import { repairVoiceAssets } from "../core/voice";
import { recognizeStyle } from "../core/recognize";
import { configIsUsable } from "../api/providers";
import { useAssetThumbs, ensureAssetLoaded, clearThumbCache } from "../composables/useAssetThumbs";
import LazyThumb from "../components/LazyThumb.vue";
import AssetPreview from "../components/AssetPreview.vue";
import VisualBiblePanel from "../components/VisualBiblePanel.vue";
import {
  imageRunPreparationStages,
  resumeStagesAfterVisualApproval,
  visualBibleNeedsReview,
} from "../core/visualBibleWorkflow";
import { parseAssetMap } from "../core/assetMap";
import { parseChapterScript } from "../core/dataValidation";

const tab = ref<"run" | "cards" | "video" | "script" | "log" | "failed" | "asset" | "bible">("run");

/* ---- 执行方式三模式（互斥）：整书生成 / 单阶段重跑 / 单章节生成 ---- */
type RunMode = "full" | "stage" | "chapter";
const RUN_MODE_KEY = "novelforge:runMode";
function initialRunMode(): RunMode {
  try {
    const s = localStorage.getItem(RUN_MODE_KEY);
    if (s === "full" || s === "stage" || s === "chapter") return s;
  } catch {
    /* 忽略 */
  }
  return projectState.novel || projectState.lastResult ? "chapter" : "full";
}
const runMode = ref<RunMode>(initialRunMode());
watch(runMode, (m) => {
  try {
    localStorage.setItem(RUN_MODE_KEY, m);
  } catch {
    /* 忽略 */
  }
});
const runModeHint = computed(() => {
  switch (runMode.value) {
    case "full":
      return t("整书生成：按下方勾选的阶段＋章节跑全流程，适合第一次生成");
    case "stage":
      return t("单阶段：只重跑某一个阶段，其余复用缓存");
    default:
      return t("单章节：逐章生成剧本＋图像＋组装（不含配音），配音另行处理");
  }
});
/** 从失败项等位置跳回整书生成 */
function goFullMode(): void {
  runMode.value = "full";
  nextTick(() => {
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      /* 忽略 */
    }
  });
}
const error = ref("");
const busy = ref(false);
const pendingResumeStages = ref<StageKey[]>([]);
const pipelineRef = ref<Pipeline | null>(null);
/** 中止/异常路径从 Pipeline 收回的失败任务（未完成 run 的失败项也可见） */
const lastRunFailedTasks = ref<FailedTask[]>([]);
const scriptFiles = ref<{ name: string; text: string }[]>([]);
const currentScript = ref("");
const videoStatus = ref<Record<string, boolean>>({});
const videoInput = ref<HTMLInputElement | null>(null);
const videoImportTarget = ref<{ id: string; title: string } | null>(null);
const copiedMsg = ref("");
const logPanelRef = ref<HTMLElement | null>(null);
const LOG_RENDER_LIMIT = 300;
const visibleLogs = computed(() => projectState.logs.slice(-LOG_RENDER_LIMIT));

const PIPELINE_STEPS = ["分章", "翻译", "提取", "剧本", "图像", "配音", "组装"];
const pipelineSteps = computed(() => PIPELINE_STEPS.map((s) => t(s)));
const currentStep = ref(-1);
const failedSteps = ref<number[]>([]);

// 实时进度：最近一条带 progress 的管线事件（图片 12/45 · 当前任务）
const liveProgress = ref<{ step: string; done: number; total: number; label: string } | null>(null);

/**
 * 本次运行包含的阶段名（中文 step 名，与 STAGE_LABELS 一致）。
 * 步骤指示器与实时进度条只响应这些阶段——缓存复用/未勾选阶段的日志不再点亮指示器，
 * 解决"单阶段重跑时指示器一步步走完所有阶段"的误导。
 */
const activeRunLabels = ref<string[]>([]);

watch(
  () => projectState.logs.length,
  async () => {
    const last = projectState.logs[projectState.logs.length - 1];
    if (last) {
      const idx = PIPELINE_STEPS.indexOf(last.step);
      // 严格门控：只响应本次运行包含的阶段；空闲时（门控已清空）任何阶段日志都不再拨动指示器
      const inRun = activeRunLabels.value.includes(last.step);
      if (idx >= 0 && last.level !== "error" && inRun) currentStep.value = Math.max(currentStep.value, idx);
      if (last.level === "error" && idx >= 0 && !failedSteps.value.includes(idx)) failedSteps.value.push(idx);
      if (last.progress && inRun) liveProgress.value = { step: last.step, ...last.progress };
    }
    await nextTick();
    if (logPanelRef.value) logPanelRef.value.scrollTop = logPanelRef.value.scrollHeight;
  },
);

const livePct = computed(() => {
  const p = liveProgress.value;
  if (!p || p.total <= 0) return 0;
  return Math.round((p.done / p.total) * 100);
});

const costText = computed(() => {
  const r = projectState.lastResult;
  if (!r) return null;
  const c = r.cost;
  return {
    llm: `${c.llmTokens.toLocaleString()} tokens`,
    image: `${c.imageCount} ${t("张")}`,
    tts: `${c.ttsChars.toLocaleString()} ${t("字符")}`,
  };
});

const failedTasks = computed<FailedTask[]>(() => {
  const persisted = projectState.lastResult?.failedTasks ?? [];
  const extra = lastRunFailedTasks.value.filter(
    (f) => !persisted.some((x) => x.id === f.id),
  );
  return [...persisted, ...extra];
});

/** 失败任务按错误分类汇总（失败项页签顶部小卡） */
const failedTaskSummary = computed(() => {
  const counts = new Map<string, { count: number; label: string; icon: string }>();
  for (const f of failedTasks.value) {
    const cls = classifyError({ message: f.message });
    const key = ERROR_CLASS_LABEL[cls];
    const cur = counts.get(key) ?? { count: 0, label: key, icon: ERROR_CLASS_ICON[cls] };
    cur.count++;
    counts.set(key, cur);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
});

const videoPoints = computed<(VideoSuggestion & { chapter: number; location: string; enabled: boolean })[]>(() => {
  const r = projectState.lastResult;
  if (!r) return [];
  return r.chapters.flatMap((c) =>
    c.scenes.flatMap((s) =>
      (s.videoPoints || []).map((vp) => ({
        ...vp,
        chapter: c.chapter + 1,
        location: s.location,
        enabled: !!videoStatus.value[sanitizeId(vp.id)],
      })),
    ),
  );
});

/* ==================== 分阶段生成 ==================== */

const selectedStages = ref<Record<StageKey, boolean>>({ split: true, translate: true, extract: true, script: true, image: true, voice: true, assemble: true });
const stageFeedback = ref<Partial<Record<StageKey, string>>>({});
const outputDirDraft = ref("");

watch(
  () => projectState.outputDir,
  (value) => { outputDirDraft.value = value; },
  { immediate: true },
);

/* ---- 分阶段状态看板：各阶段 未运行/进行中/完成/失败 ---- */

const stageStatus = useStageStatus({
  getOutputDir: () => projectState.outputDir,
  getNovel: () => projectState.novel,
  getLanguage: () => projectState.options.language ?? "",
  getFailedTasks: () => failedTasks.value,
  getLogFailedStages: () => logFailedStages.value,
  getBusy: () => busy.value,
  getRunningStages: () => runningStages.value,
  getResult: () => projectState.lastResult,
  getOptions: () => projectState.options,
  getTtsConfig: () => activeConfig("tts"),
});

/** 每个阶段失败任务数（用于徽标显示） */
const failedCounts = computed<Record<StageKey, number>>(() => {
  const out = {} as Record<StageKey, number>;
  for (const f of failedTasks.value) {
    const k = stageStatus.STEP_TO_STAGE[f.step];
    if (k) out[k] = (out[k] ?? 0) + 1;
  }
  return out;
});

/* ---- 单章节生成：AI 分章 → 逐章内容（剧本＋图像＋组装，不含配音） ---- */

const chapterStatus = useChapterStatus({
  getOutputDir: () => projectState.outputDir,
  getNovel: () => projectState.novel,
  getOptions: () => projectState.options,
  getResult: () => projectState.lastResult,
  getTtsConfig: () => activeConfig("tts"),
  getLlmAvailable: () => !!activeConfig("llm")?.apiKey,
});

const enabledNovelChapters = computed(() => projectState.novel?.chapters.filter((c) => c.enabled !== false) ?? []);
const disabledNovelChapters = computed(() => projectState.novel?.chapters.filter((c) => c.enabled === false) ?? []);

/** 停用/启用章节（持久化；停用后管线跳过该章，编号会前移，配音 key 随之变化） */
function toggleNovelChapter(novelIdx: number): void {
  const ch = projectState.novel?.chapters.find((c) => c.index === novelIdx);
  if (!ch) return;
  ch.enabled = ch.enabled === false ? true : false;
  scheduleSave();
  void chapterStatus.refresh();
  void stageStatus.refresh();
  pushLog({
    step: "分章",
    message: ch.enabled === false
      ? `第 ${novelIdx + 1} 章「${ch.title}」已停用（不再参与生成；注意后续章节编号会前移）`
      : `第 ${novelIdx + 1} 章「${ch.title}」已重新启用`,
    level: "info",
    at: Date.now(),
  });
}

/* 分章来源徽标：让用户一眼看出当前分章是 AI 的还是规则机械切的 */
interface SplitMetaState {
  method: SplitMethod | "legacy" | "import" | "unknown";
  stale: boolean;
  discarded: number;
  count: number;
}
const splitMeta = ref<SplitMetaState>({ method: "unknown", stale: false, discarded: 0, count: 0 });
async function loadSplitMeta(): Promise<void> {
  const dir = projectState.outputDir;
  const novel = projectState.novel;
  if (!dir || !novel) {
    splitMeta.value = { method: "unknown", stale: false, discarded: 0, count: 0 };
    return;
  }
  try {
    const { text } = await tauri.readTextFile(`${dir}/.novel2vn/split.json`);
    const parsed = JSON.parse(text) as { fp?: string; chapters?: unknown[]; method?: SplitMethod; discarded?: number };
    if (!parsed || !Array.isArray(parsed.chapters)) throw new Error("bad split.json");
    splitMeta.value = {
      method: parsed.method ?? "legacy",
      stale: typeof parsed.fp === "string" && novel.fullText ? parsed.fp !== novelFingerprint(novel.fullText) : false,
      discarded: parsed.discarded ?? 0,
      count: parsed.chapters.length,
    };
  } catch {
    // 无分章缓存：小说自带多章＝导入规则切分；单章＝尚未分章
    const n = novel.chapters.length;
    const single = n <= 1;
    splitMeta.value = { method: single ? "unknown" : "import", stale: false, discarded: 0, count: single ? 0 : n };
  }
}
const splitMetaText = computed(() => {
  const m = splitMeta.value;
  switch (m.method) {
    case "ai":
      return m.stale
        ? t("分章：AI（已过期，小说内容已变，建议重切）")
        : `${t("分章：AI")}${m.count ? `（${m.count}${t("章")}` : ""}${m.discarded > 0 ? `${t("，已丢弃")} ${m.discarded} ${t("杂项")}` : ""}${t("）")}`;
    case "fallback":
      return t("分章：规则回退（未配置文本 API，机械切分，建议配置后重切）");
    case "legacy":
      return t("分章：旧版缓存（建议用 AI 重切一次）");
    case "import":
      return t("分章：导入规则切分（原文标题机械切块，未跑 AI 分章）");
    default:
      return t("分章：尚未分章");
  }
});

/* 分章确认（按输出目录持久化；新项目队列要求先确认，老项目有成品则不强制） */
const splitOpinion = ref("");
const splitConfirmed = ref(false);
function splitConfirmKey(): string {
  return `novelforge:splitConfirmed:${projectState.outputDir}`;
}
function loadSplitConfirmed(): void {
  try {
    splitConfirmed.value = localStorage.getItem(splitConfirmKey()) === "1";
  } catch {
    splitConfirmed.value = false;
  }
}
watch(() => projectState.outputDir, () => {
  loadSplitConfirmed();
  void chapterStatus.refresh();
  void loadSplitMeta();
}, { immediate: true });
watch(() => projectState.novel, () => {
  void chapterStatus.refresh();
  void loadSplitMeta();
});

/** AI 分章预览：只跑分章（＋提取兜底，新项目无卡片时分章单跑会失败），跑完在章节盘核对边界 */
async function previewSplit(): Promise<void> {
  if (!projectState.novel) {
    error.value = t("请先在「导入小说」页导入小说（或加载示例小说）");
    return;
  }
  const fb = splitOpinion.value.trim();
  // 规则回退升级 AI 分章走显式确认（管线不再自动升级）：无意见但缓存是回退产物且有 LLM 时先问
  if (!fb && splitMeta.value?.method === "fallback" && !!activeConfig("llm")?.apiKey) {
    if (!window.confirm("当前是旧规则回退分章（机械切分），是否升级为 AI 分章？升级后下游剧本/图像/配音缓存将作废重跑。")) return;
  }
  const upgrade = !fb && splitMeta.value?.method === "fallback" && !!activeConfig("llm")?.apiKey;
  const ok = await execute({
    stages: ["split", "extract"],
    feedback: fb ? { split: fb } : undefined,
    forceStages: fb || upgrade ? ["split"] : undefined,
  });
  if (ok) {
    splitOpinion.value = "";
    splitConfirmed.value = false;
    try {
      localStorage.removeItem(splitConfirmKey());
    } catch {
      /* 忽略 */
    }
    void chapterStatus.refresh();
    const n = projectState.novel?.chapters.length ?? 0;
    pushLog({
      step: "分章",
      message: fb
        ? `AI 分章完成：共 ${n} 章（分章变化会作废下游剧本/图像缓存）。请在下方核对每章边界/标题/字数，确认无误后点「确认分章」，再逐章生成内容`
        : `AI 分章完成：共 ${n} 章。请在下方核对每章边界/标题/字数，确认无误后点「确认分章」，再逐章生成内容`,
      level: "success",
      at: Date.now(),
    });
  }
}

function confirmSplit(): void {
  splitConfirmed.value = true;
  try {
    localStorage.setItem(splitConfirmKey(), "1");
  } catch {
    /* 忽略 */
  }
  pushLog({
    step: "分章",
    message: "分章已确认，可以逐章生成内容了（单章链＝剧本＋图像＋组装，不含配音；配音请跑配音阶段或单句重配）",
    level: "success",
    at: Date.now(),
  });
}

const queueRunning = ref(false);

/** 顺序生成未完成章节：逐章调单章链，前一章落盘后再跑下一章；失败/中止即停 */
async function runChapterQueue(): Promise<void> {
  if (busy.value || queueRunning.value) return;
  const novel = projectState.novel;
  if (!novel) {
    error.value = t("请先在「导入小说」页导入小说（或加载示例小说）");
    return;
  }
  if (!splitConfirmed.value && !projectState.lastResult) {
    error.value = t("请先点「AI 分章预览」核对章节并点「确认分章」，再顺序生成");
    return;
  }
  await chapterStatus.refresh();
  const targets = novel.chapters.filter(
    (c) => c.enabled !== false && !isChapterContentComplete(chapterStatus.lights[c.index] ?? emptyChapterLight()),
  );
  if (!targets.length) {
    pushLog({ step: "单章", message: "全部启用章节的内容（剧本＋图像）均已完成，无需再跑", level: "success", at: Date.now() });
    return;
  }
  queueRunning.value = true;
  let done = 0;
  let stoppedAt = "";
  try {
    for (const ch of targets) {
      if (!queueRunning.value) {
        stoppedAt = ch.title;
        break;
      }
      pushLog({ step: "单章", message: `队列进度 ${done + 1}/${targets.length}：开始第 ${ch.index + 1} 章「${ch.title}」`, level: "info", at: Date.now() });
      const ok = await runChapterFullRegen(ch.index);
      if (!ok) {
        stoppedAt = ch.title;
        break;
      }
      done++;
    }
  } finally {
    queueRunning.value = false;
    void chapterStatus.refresh();
  }
  if (done >= targets.length) {
    pushLog({ step: "单章", message: `队列完成：${done} 章内容全部生成完毕`, level: "success", at: Date.now() });
  } else {
    pushLog({
      step: "单章",
      message: `队列停止：已完成 ${done}/${targets.length} 章${stoppedAt ? `，停在「${stoppedAt}」` : ""}（失败或手动中止），可处理后再次点顺序生成继续（已完成的章会自动跳过）`,
      level: "warn",
      at: Date.now(),
    });
  }
}

function stopChapterQueue(): void {
  queueRunning.value = false;
  pipelineRef.value?.abort();
}

/** 日志中「最后一条」为 error 的阶段（用于中断/未落盘运行的失败识别，成功后会更新为成功状态） */
const logFailedStages = computed<Set<StageKey>>(() => {
  const levels = getStageLastLevels();
  const set = new Set<StageKey>();
  for (const k of STAGE_ORDER) if (levels[k] === "error") set.add(k);
  return set;
});

/** 当前正在执行的阶段（由增量维护的「最近非 error 日志阶段」推导，O(1)） */
const runningStages = computed<StageKey[]>(() => {
  if (!busy.value && !projectState.running) return [];
  const last = getLastActiveStage();
  return last ? [last] : [];
});

watch(
  () => [projectState.outputDir, projectState.lastResult?.failedTasks, projectState.options.language],
  () => void stageStatus.refresh(),
  { deep: true },
);
void stageStatus.refresh();

/* ---- 风格参考图：上传图片 → AI 识别画风 → 写入统一画风约束 ---- */
const styleRefSrc = ref("");
const styleRecognizing = ref(false);
const styleRefInput = ref<HTMLInputElement | null>(null);

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

async function pickStyleRef(): Promise<void> {
  if (!isTauri()) {
    styleRefInput.value?.click();
    return;
  }
  const picked = await open({
    multiple: false,
    filters: [{ name: t("参考图"), extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  if (!picked || typeof picked !== "string") return;
  try {
    const b64 = await tauri.readFileBase64(picked);
    styleRefSrc.value = `data:${mimeOf(picked)};base64,${b64}`;
    pushLog({ step: "画风", message: `已选择风格参考图：${picked.split(/[\\/]/).pop()}`, level: "info", at: Date.now() });
    void recognizeStyleAndApply(styleRefSrc.value);
  } catch (e) {
    pushLog({ step: "画风", message: `读取参考图失败：${errMsg(e)}`, level: "error", at: Date.now() });
  }
}

async function onStyleRefFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const b64 = await fileToBase64(file);
  styleRefSrc.value = `data:${file.type || "image/png"};base64,${b64}`;
  void recognizeStyleAndApply(styleRefSrc.value);
}

async function recognizeStyleAndApply(b64: string): Promise<void> {
  const cfg = activeConfig("vision");
  if (!configIsUsable(cfg, "vision")) {
    pushLog({ step: "画风", message: t("图片识别 API 未配置或不可用，无法识别画风；请先在「API 配置」页配置"), level: "warn", at: Date.now() });
    return;
  }
  styleRecognizing.value = true;
  try {
    const style = await recognizeStyle(cfg, b64);
    projectState.options.imageStyle = style;
    pushLog({ step: "画风", message: `已识别画风并写入「统一画风」：${style.slice(0, 100)}…`, level: "success", at: Date.now() });
  } catch (e) {
    pushLog({ step: "画风", message: `识别画风失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    styleRecognizing.value = false;
  }
}

const selectedStagesList = computed<StageKey[]>(() => STAGE_ORDER.filter((s) => selectedStages.value[s]));
const visualBibleReviewNeeded = computed(() => projectState.options.useImage && visualBibleNeedsReview(projectState.visualBible));

/* ==================== 剧本 Tab 单章重生成 ==================== */

const scriptChapterFeedback = ref<Record<number, string>>({});

/* ==================== 素材 Tab ==================== */

const assetMap = ref<AssetMap | null>(null);
const assetTab = ref<"figure" | "item" | "bg" | "cg" | "voice">("figure");
const assetBusy = ref("");
const assetFeedback = ref<Record<string, string>>({ figure: "", item: "", bg: "", cg: "" });
const voiceChapterFilter = ref(0);
const voiceCharFilter = ref("");

// 素材大图预览（点击缩略图放大）
const preview = ref<{ path: string; label: string } | null>(null);

// 素材重生成：可中断 + 实时进度
const regenAbort = ref(false);
const regenProgress = ref<{ done: number; total: number; label: string } | null>(null);

function openPreview(path: string | undefined, label: string): void {
  if (!path) return;
  preview.value = { path, label };
}

function regenCtl(): { signal: { aborted: () => boolean }; onProgress: (done: number, total: number, label: string, path?: string) => void } {
  return {
    signal: { aborted: () => regenAbort.value },
    onProgress: (done, total, label, path) => {
      regenProgress.value = { done, total, label };
      // 重生成覆盖同名文件：清该路径的缩略图缓存并重新加载，让新图逐张上屏
      if (path) {
        clearThumbCache([path]);
        loadAssetDataUrl(path);
      }
    },
  };
}

function resetRegenState(): void {
  regenAbort.value = false;
  regenProgress.value = null;
}

const regenPct = computed(() => {
  const p = regenProgress.value;
  if (!p || p.total <= 0) return 0;
  return Math.round((p.done / p.total) * 100);
});

// 素材多选批量重生成：选中项 = kind:id[:sub]，如 figure:linche:happy / threeview:linche / bg:s1 / cg:1:s1
const selected = ref<Set<string>>(new Set());
const selectedCount = computed(() => selected.value.size);

function toggleSelect(key: string): void {
  const s = new Set(selected.value);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  selected.value = s;
}

function clearSelected(): void {
  selected.value = new Set();
}

function selectAllInTab(): void {
  const s = new Set(selected.value);
  const add = (k: string) => s.add(k);
  switch (assetTab.value) {
    case "figure":
      for (const r of figureRows.value) {
        add(`threeview:${r.id}`);
        for (const e of r.emotions) add(`figure:${r.id}:${e.emo}`);
        for (const a of r.actions) add(`action:${r.id}:${a.id}`);
      }
      break;
    case "item":
      for (const r of itemRows.value) add(`item:${r.id}`);
      break;
    case "bg":
      for (const r of bgRows.value) add(`bg:${r.sceneId}`);
      break;
    case "cg":
      for (const r of cgRows.value) add(`cg:${r.chapter}:${r.sceneId}`);
      break;
    default:
      break;
  }
  selected.value = s;
}

/** 选择键 → 图像任务匹配：三视图选中会级联该角色的立绘/动作（与单张重生成语义一致） */
async function regenSelected(): Promise<void> {
  const keys = Array.from(selected.value);
  if (!keys.length) return;
  const ctx = await regenCtx();
  if (!ctx) return;
  assetBusy.value = `batch:${keys.length} 项`;
  resetRegenState();
  try {
    const { signal, onProgress } = regenCtl();
    const predicate = (t: ImageTask) => keys.some((k) => imageTaskMatchesSelectionKey(t, k));
    const results = await regenerateImages(ctx, predicate, undefined, signal, onProgress);
    selected.value = new Set();
    await afterAssetRegen(`已重新生成 ${results.length} 项（批量）`, results.length);
  } catch (e) {
    pushLog({ step: "素材", message: `批量重生成失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    resetRegenState();
    await loadAssetMapNow(true);
  }
}

/**
 * 补全缺失图片：检查所有图像任务，只重新生成「缓存目录里没有对应文件」的任务；
 * 已存在的图完全不动（不覆盖、不丢失），一次性把中断/失败遗漏的图补齐。
 */
async function regenMissingImages(): Promise<void> {
  const ctx = await regenCtx();
  if (!ctx) return;
  const cacheRoot = `${ctx.outputDir}/.novel2vn/cache`;
  const approvedBible = ctx.visualBible?.status === "approved" ? ctx.visualBible : undefined;
  const allTasks = buildImageTasks(ctx.chapters, ctx.cards, {
    figureEmotions: ctx.figureEmotions ?? true,
    detail: ctx.figureDetail ?? "full",
    threeView: ctx.threeView !== false,
    actions: ctx.actions !== false,
    // 必须覆盖全部动作：regenerateImages 侧按 maxActionsPerCharacter: 0（全量）重建任务，
    // 这里若用默认前 2 个，第 3 个起的动作永远检测不到缺失、也永远补不上。
    maxActionsPerCharacter: 0,
    style: approvedBible?.styleDescription ?? ctx.style,
    baseSeed: ctx.imageSeed,
    styleAnchor: approvedBible ? false : ctx.styleAnchor !== false,
  });
  // 预检缺失：任务文件在 cache/images 下不存在（含 .png/.jpg/.webp 变体）
  const missingTaskKeys = new Set<string>();
  for (const t of allTasks) {
    if (t.kind === "anchor") continue; // 锚点不在素材映射里，跳过
    const base = `${cacheRoot}/images/${t.fileName.replace(/\.png$/i, "")}`;
    const variants = await Promise.all([
      tauri.pathExists(`${base}.png`).catch(() => false),
      tauri.pathExists(`${base}.jpg`).catch(() => false),
      tauri.pathExists(`${base}.jpeg`).catch(() => false),
      tauri.pathExists(`${base}.webp`).catch(() => false),
    ]);
    if (!variants.some(Boolean)) missingTaskKeys.add(imageTaskIdentity(t));
  }
  if (!missingTaskKeys.size) {
    pushLog({ step: "素材", message: "没有缺失的图片，无需补全", level: "info", at: Date.now() });
    return;
  }
  assetBusy.value = `补全缺失图片（${missingTaskKeys.size} 张）`;
  resetRegenState();
  try {
    const { signal, onProgress } = regenCtl();
    const predicate = (t: ImageTask) => missingTaskKeys.has(imageTaskIdentity(t));
    const results = await regenerateImages(ctx, predicate, undefined, signal, onProgress);
    pushLog({
      step: "素材",
      message: results.length
        ? `补全缺失图片完成：重新生成 ${results.length} 张（已存在的图未改动）`
        : "补全缺失图片完成（没有需要补的）",
      level: "success",
      at: Date.now(),
    });
    await afterAssetRegen(`补全缺失图片（${results.length} 张）`, results.length);
  } catch (e) {
    pushLog({ step: "素材", message: `补全缺失图片失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    resetRegenState();
    await loadAssetMapNow(true);
  }
}

const FIGURE_EMOTIONS = ["normal", "happy", "sad", "angry", "surprised"];
const EMOTION_LABELS: Record<string, string> = { normal: t("默认"), happy: t("开心"), sad: t("悲伤"), angry: t("愤怒"), surprised: t("惊讶") };

/** 单张素材重新抠图：不动原图，只重跑抠图出透明底；完成后刷新素材映射（仅立绘/物品，背景/CG 不抠） */
async function reCutout(mapKey: "figure" | "item", assetKey: string, filePath: string): Promise<void> {
  if (!filePath || !projectState.outputDir) return;
  if (assetBusy.value) return;
  assetBusy.value = `cutout:${assetKey}`;
  try {
    const newPath = await reCutoutAsset(projectState.outputDir, mapKey, assetKey, filePath, (ev) => pushLog(ev));
    if (newPath && newPath !== filePath) {
      pushLog({ step: "素材", message: `抠图完成：${assetKey} → 透明底 PNG`, level: "success", at: Date.now() });
      // 抠图产生了新文件：重新组装，把新图复制进游戏目录（否则预览里还是旧图）
      await execute({ stages: ["assemble"] });
    } else if (newPath === filePath) {
      pushLog({ step: "素材", message: `${assetKey} 无需抠图（已透明或背景无法识别）`, level: "info", at: Date.now() });
    }
    await loadAssetMapNow(true);
  } catch (e) {
    const msg = errMsg(e);
    const hint = cutoutErrorHint(msg);
    pushLog({ step: "素材", message: `抠图失败：${assetKey}（${msg.slice(0, 220)}${hint ? " " + hint : ""}）`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
  }
}

// 素材预览/试听：读成 base64 data-URL（桌面/网页通用），失败不重试、并发受限，避免卡死
const { loadAssetDataUrl, mimeOf } = useAssetThumbs();

/**
 * 素材映射重载。clearAll=false（默认，生成期间轮询）：只清"新增/消失"路径的缩略图缓存，
 * 避免每次 2s 刷新都清空全部缓存、导致可见图全部重新读盘。
 * clearAll=true（管线完成/中止/重生成后）：同一路径可能被覆盖为新图，需全清。
 */
async function loadAssetMapNow(clearAll = false): Promise<void> {
  try {
    if (!projectState.outputDir) {
      assetMap.value = null;
      return;
    }
    const { text } = await tauri.readTextFile(`${projectState.outputDir}/.novel2vn/assets.json`);
    const next = parseAssetMap(JSON.parse(text));
    if (clearAll) {
      clearThumbCache();
    } else {
      const changed = diffAssetPaths(assetMap.value, next);
      if (changed.length) {
        clearThumbCache(changed);
      }
    }
    assetMap.value = next;
    // 缩略图缓存被清后，LazyThumb 通过 watch 感知缓存条目消失并自动重新加载（见 LazyThumb.vue），
    // 无需在此主动全量重读，避免一次性把上百张图读进内存。
    // 结构兜底（单点）：lastResult 缺 cards/chapters（首次运行、中止后）时从磁盘补，
    // 素材页行结构恢复后，映射里的每张图才能对应显示到行上。
    // ensureLiveResultShape 只读磁盘、不回调 loadAssetMapNow，无递归。
    if (!projectState.lastResult?.cards?.characters?.length || !projectState.lastResult?.chapters?.length) {
      void ensureLiveResultShape(projectState.outputDir);
    }
  } catch {
    assetMap.value = null;
  }
}

/** 比较新旧 assetMap 的素材路径，返回新增/消失的路径（同路径覆盖无法感知，需 clearAll） */
function diffAssetPaths(oldMap: AssetMap | null, newMap: AssetMap | null): string[] {
  const collect = (m: AssetMap | null, into: Set<string>): void => {
    if (!m) return;
    for (const v of Object.values(m.bg ?? {})) if (v) into.add(v);
    for (const v of Object.values(m.cg ?? {})) if (v) into.add(v);
    for (const v of Object.values(m.figure ?? {})) if (v) into.add(v);
    for (const v of Object.values(m.item ?? {})) if (v) into.add(v);
    for (const v of Object.values(m.vocal ?? {})) if (v) into.add(v);
  };
  const oldSet = new Set<string>();
  const newSet = new Set<string>();
  collect(oldMap, oldSet);
  collect(newMap, newSet);
  const changed: string[] = [];
  for (const p of oldSet) if (!newSet.has(p)) changed.push(p);
  for (const p of newSet) if (!oldSet.has(p)) changed.push(p);
  return changed;
}

// 生成期间实时刷新素材：每张图生成后会增量写入 assets.json，这里每 2s 轮询一次，
// 新图一到就插入界面，无需等整批生成完。
let assetLiveTimer: number | undefined;
let assetLiveFingerprint = "";
function startAssetLiveRefresh(): void {
  assetLiveFingerprint = "";
  if (assetLiveTimer !== undefined) return;
  assetLiveTimer = window.setInterval(() => {
    if (!projectState.outputDir) return;
    // 结构同步与映射刷新共用 2s 轮询节拍（确保首次运行/中止后素材页结构也能跟上）
    syncLiveResultShape();
    void tauri
      .readTextFile(`${projectState.outputDir}/.novel2vn/assets.json`)
      .then(({ text }) => {
        if (text === assetLiveFingerprint) return;
        assetLiveFingerprint = text;
        void loadAssetMapNow();
      })
      .catch(() => {});
  }, 2000);
}
function stopAssetLiveRefresh(): void {
  if (assetLiveTimer !== undefined) {
    window.clearInterval(assetLiveTimer);
    assetLiveTimer = undefined;
  }
}

const figureRows = computed(() => {
  const r = projectState.lastResult;
  if (!r || !assetMap.value) return [];
  return r.cards.characters.map((c) => ({
    id: c.id,
    name: c.name,
    hasRef: !!c.referenceImage,
    threeView: assetMap.value!.figure[`${c.id}_threeview`],
    emotions: FIGURE_EMOTIONS.map((emo) => ({ emo, file: assetMap.value!.figure[emo === "normal" ? c.id : `${c.id}_${emo}`] })),
    actions: (c.actions || []).map((a) => ({ id: a.id, name: a.name, file: assetMap.value!.figure[`${c.id}_act_${a.id}`] })),
  }));
});

const itemRows = computed(() => {
  const r = projectState.lastResult;
  if (!r || !assetMap.value) return [];
  return r.cards.items.map((it) => ({ id: it.id, name: it.name, file: assetMap.value!.item[it.id] }));
});

const bgRows = computed(() => {
  const r = projectState.lastResult;
  if (!r || !assetMap.value) return [];
  return r.chapters.flatMap((ch) =>
    ch.scenes.map((s) => ({ chapter: ch.chapter + 1, sceneId: s.id, location: s.location, file: assetMap.value!.bg[s.id] })),
  );
});

const cgRows = computed(() => {
  const r = projectState.lastResult;
  if (!r || !assetMap.value) return [];
  return r.chapters.flatMap((ch) =>
    ch.scenes
      .filter((s) => s.cgEvent)
      .map((s) => ({ chapter: ch.chapter + 1, sceneId: s.id, title: s.cgEvent!.title, file: assetMap.value!.cg[s.id] ?? assetMap.value!.cg[`${ch.chapter}_${s.id}`] })),
  );
});

const charNameOf = computed(() => {
  const map: Record<string, string> = {};
  for (const c of projectState.lastResult?.cards.characters ?? []) map[c.id] = c.name;
  return (id: string) => map[id] || id;
});

const voiceRows = computed(() => {
  const r = projectState.lastResult;
  if (!r || !assetMap.value) return [];
  const rows = r.chapters.flatMap((ch) =>
    ch.scenes.flatMap((s) =>
      s.lines.map((line, i) => {
        const key = `ch${ch.chapter}_${sanitizeId(s.id)}_${i}`;
        const file = assetMap.value!.vocal[key];
        const failed = !file && failedVocalKeys.value.has(key);
        if (line.type === "dialogue") {
          return { key, chapter: ch.chapter + 1, scene: s.location, charId: line.characterId, displayName: charNameOf.value(line.characterId), text: line.text, file, failed };
        }
        // 旁白/独白默认隐藏（避免配音表看起来断裂）；打开开关后显示，key 与配音任务一致
        if (!showNarrationVoice.value) return null;
        return { key, chapter: ch.chapter + 1, scene: s.location, charId: "narrator", displayName: line.monologue ? t("内心独白") : t("旁白"), text: line.text, file, failed };
      }),
    ),
  ).filter((x): x is NonNullable<typeof x> => !!x);
  return rows.filter(
    (r) => (!voiceChapterFilter.value || r.chapter === voiceChapterFilter.value) && (!voiceCharFilter.value || r.charId === voiceCharFilter.value),
  );
});

const voiceChapterOptions = computed(() => {
  const r = projectState.lastResult;
  if (!r) return [];
  // 双标注：管线重编号后"第X章"可能不再等于原文章节号，对齐不上时同时标出原文章节
  const novelEnabled = projectState.novel?.chapters.filter((c) => c.enabled !== false) ?? [];
  const aligned = projectState.novel != null && novelEnabled.length === r.chapters.length;
  return r.chapters.map((c, i) => {
    const nc = aligned ? novelEnabled[i] : undefined;
    const suffix = nc && (nc.index + 1 !== c.chapter + 1 || nc.title !== c.title)
      ? `（原文第 ${nc.index + 1} 章 ${nc.title}）`
      : "";
    return { value: c.chapter + 1, label: `第 ${c.chapter + 1} 章 ${c.title}${suffix}` };
  });
});

/** 剧本章节数与当前小说启用章节数不一致（重分章/禁用章节后未重跑剧本），编号可能错位 */
const voiceChapterMismatch = computed(() => {
  const r = projectState.lastResult;
  if (!r || !projectState.novel) return "";
  const novelEnabled = projectState.novel.chapters.filter((c) => c.enabled !== false).length;
  if (novelEnabled === r.chapters.length) return "";
  return `剧本共 ${r.chapters.length} 章，当前小说启用 ${novelEnabled} 章，两者不一致（可能重分章 / 禁用章节后未重跑剧本），章节号可能错位，请先重跑剧本再配音`;
});

/** 配音失败的台词 key（vocal_ 前缀），用于在配音表区分"配音失败"与"未生成" */
const failedVocalKeys = computed(() => {
  const set = new Set<string>();
  for (const f of failedTasks.value) {
    if (f.id.startsWith("vocal_")) set.add(f.id.slice("vocal_".length));
  }
  return set;
});

const voiceCharOptions = computed(() => {
  const r = projectState.lastResult;
  if (!r) return [];
  return r.cards.characters.map((c) => ({ value: c.id, label: c.name }));
});

const voiceLimit = ref(100);
const voiceRowsShown = computed(() => voiceRows.value.slice(0, voiceLimit.value));
/** 配音表是否显示旁白/独白行（默认只显示对话；单看对话表会觉得剧情断裂） */
const showNarrationVoice = ref(false);

/** 配音重生成是否可用：已配置 TTS API 且存在已生成的卡片即可（useTts 仅控制自动生成阶段，手动重配不受限） */
const ttsReady = computed(() => {
  const cfg = activeConfig("tts");
  return !!cfg?.apiKey;
});

/* ==================== 执行管线（分阶段） ==================== */

interface ExecuteOptions {
  stages: StageKey[];
  feedback?: StageFeedback;
  forceStages?: StageKey[];
  clearLogsFirst?: boolean;
  rerunChapters?: number[] | null;
  /** 单章节模式保护：缺剧本缓存时在组装前中止，避免游戏缩水 */
  requireFullScriptCoverage?: boolean;
  /** 纯追加式增量加更：旧全文 + 新增文本（要求 stages 含 split+extract+script） */
  append?: { baseFullText: string; tailText: string };
}

async function execute(opts: ExecuteOptions): Promise<boolean> {
  error.value = "";
  if (busy.value || assetBusy.value) return false;
  let novel = projectState.novel;
  // 需要小说正文的阶段（分章/翻译/提取/剧本）；图像/配音/组装只依赖已生成的卡片与章节，不强制 novel
  const needsNovel = opts.stages.some((s) => s === "split" || s === "translate" || s === "extract" || s === "script");
  if (needsNovel && !novel) {
    error.value = t("请先在「导入小说」页导入小说（或加载示例小说）");
    return false;
  }
  // 图像/配音/组装等纯资产阶段：没有卡片就无从生成
  if (!needsNovel && !projectState.lastResult) {
    error.value = t("请先运行文本阶段生成角色卡片，再执行图像/配音/组装");
    return false;
  }
  // 资产阶段重生成时源小说可能已失效（novel 为 null）：用 lastResult 的章节构造占位 novel，
  // 让配音/组装等阶段仍能基于已有剧本缓存运行，不必重新导入小说。
  if (!needsNovel && !novel && projectState.lastResult) {
    const r = projectState.lastResult;
    novel = {
      fileName: r.meta.title || "已生成项目",
      sourcePath: "",
      encoding: "utf-8",
      fullText: "",
      chapters: r.chapters.map((c) => ({ index: c.chapter, title: c.title, text: "", charCount: 0 })),
    };
  }
  if (!opts.stages.length) {
    error.value = t("请至少勾选一个要执行的阶段");
    return false;
  }
  logger.info("page", "执行生成", {
    stages: opts.stages,
    hasFeedback: !!opts.feedback && Object.keys(opts.feedback).length > 0,
    forceStages: opts.forceStages,
  });
  const needsVisualApproval = opts.stages.includes("image")
    && projectState.options.useImage
    && visualBibleNeedsReview(projectState.visualBible);
  if (needsVisualApproval) {
    const preparationStages = imageRunPreparationStages(opts.stages, !!projectState.lastResult);
    if (preparationStages.length) {
      const prepared = await execute({
        ...opts,
        stages: preparationStages,
        clearLogsFirst: opts.clearLogsFirst,
      });
      if (!prepared) return false;
    } else if (!projectState.lastResult) {
      error.value = t("请先运行文本阶段，生成角色卡片后再确认视觉圣经");
      tab.value = "bible";
      return false;
    }
    pendingResumeStages.value = resumeStagesAfterVisualApproval(opts.stages);
    tab.value = "bible";
    pushLog({
      step: "视觉圣经",
      message: t("图像生成前需要确认视觉圣经；文本阶段已准备，请选择来源并创建/重新确认草稿"),
      level: "info",
      at: Date.now(),
    });
    return false;
  }
  const llm = activeConfig("llm");
  const vision = activeConfig("vision");
  const image = activeConfig("image");
  const tts = activeConfig("tts");
  if (!llm?.apiKey) {
    pushLog({
      step: "提示",
      message: t("未配置文本 LLM API Key，将以演示模式运行（可完整验证剧本/渲染/组装流程）"),
      level: "warn",
      at: Date.now(),
    });
  }
  if (!projectState.outputDir) {
    projectState.outputDir = await tauri.getDefaultOutputDir().catch(() => "");
  }
  if (outputDirDraft.value && outputDirDraft.value !== projectState.outputDir) {
    if (!(await flushPendingProjectSave())) {
      error.value = t("当前项目保存失败，已取消切换输出目录");
      return false;
    }
    projectState.outputDir = outputDirDraft.value;
    configState.outputDir = outputDirDraft.value;
  }
  if (opts.clearLogsFirst) {
    clearLogs();
  }
  // 本次运行的阶段门控＋指示器无条件重置：单阶段重跑不再点亮无关阶段，
  // 缓存复用日志也不再叠加到上次的进度上
  activeRunLabels.value = opts.stages.map((s) => STAGE_LABELS[s]);
  currentStep.value = -1;
  failedSteps.value = [];
  liveProgress.value = null;
  if (projectState.options.skipCache && opts.stages.some((s) => s !== "assemble")) {
    pushLog({
      step: "提示",
      message: t("注意：已开启「跳过缓存（全量重跑）」，本次将忽略全部缓存、全量重新生成并计费；若只想补缺失项请先关闭该开关"),
      level: "warn",
      at: Date.now(),
    });
  }
  busy.value = true;
  projectState.running = true;
  const log = (ev: PipelineEvent) => {
    pushLog(ev);
    // 结构同步：提取/剧本阶段产出后（或任一进度事件）从磁盘补 cards/chapters，
    // 让素材页行结构在首次运行/中止后也即时可用（2s 节流）。
    if (ev.progress || (ev.step === "提取" && ev.level === "success") || (ev.step === "剧本" && ev.level === "success")) {
      syncLiveResultShape();
    }
    // 图像阶段每张图完成即有 progress 事件（assets.json 已增量写入）→ 立即刷新素材页，
    // 实现「生成一张就显示一个」，无需等整批完成。
    if (ev.step === "图像" && ev.progress) {
      void loadAssetMapNow().catch(() => {});
    }
  };
  try {
    const templateDir = await resolveTemplateDir();
    const pipeline = new Pipeline({
      // needsNovel 分支已校验非空；资产分支会用 lastResult 构造占位 novel，此处必然非空
      novel: novel!,
      materials: projectState.materials,
      llm: llm?.apiKey ? llm : undefined,
      vision: configIsUsable(vision, "vision") ? vision : undefined,
      image: projectState.options.useImage && image?.apiKey ? image : undefined,
      // 手动触发「配音 重新生成」时不受 useTts 开关限制：只要配置了 TTS 即允许重配
      tts: tts?.apiKey ? tts : undefined,
      visualBible: projectState.visualBible?.status === "approved" ? projectState.visualBible : undefined,
      outputDir: projectState.outputDir,
      templateDir,
      options: {
        ...projectState.options,
        rerunChapters: opts.rerunChapters !== undefined ? opts.rerunChapters ?? undefined : rerunChapters.value ?? undefined,
      },
      stages: opts.stages,
      feedback: opts.feedback,
      forceStages: opts.forceStages,
      requireFullScriptCoverage: opts.requireFullScriptCoverage,
      append: opts.append,
      log,
    });
    pipelineRef.value = pipeline;

    log({
      step: "开始",
      message: `管线启动（阶段：${opts.stages.map((s) => STAGE_LABELS[s]).join(" → ")}）`,
      level: "info",
      at: Date.now(),
    });
    // 生成期间实时刷新素材：先确保 lastResult 有结构（首次生成或重开程序时可能为空），
    // 这样素材页立即可用，图片每生成一张就通过 assetLiveRefresh 增量显示。
    if (!projectState.lastResult?.chapters?.length && projectState.outputDir) {
      await ensureLiveResultShape(projectState.outputDir);
      await loadAssetMapNow();
    }
    startAssetLiveRefresh();
    const prevResult = projectState.lastResult;
    const result = await pipeline.run();
    stopAssetLiveRefresh();
    await loadAssetMapNow(true);
    // 不含剧本阶段的运行产不出新剧本：若管线返回空剧本，保留旧剧本用于展示
    // （单章上游/分章预览等场景；日志已标记过期），避免素材/剧本页瞬间清空；下游需手动依次重跑
    if (
      !opts.stages.includes("script") &&
      result.chapters.length === 0 &&
      (prevResult?.chapters?.length ?? 0) > 0
    ) {
      result.chapters = prevResult!.chapters as typeof result.chapters;
    }
    projectState.lastResult = result;
    addRecentOutputDir(result.meta.outputDir);
    // 分章来源徽标：本次跑了分章（或透出来源）就直接更新，免一次读盘
    if (result.splitMethod !== undefined) {
      splitMeta.value = {
        method: result.splitMethod,
        stale: false,
        discarded: result.splitDiscarded ?? 0,
        count: result.splitChapters?.length ?? projectState.novel?.chapters.length ?? 0,
      };
    }
    if (result.splitChapters?.length && projectState.novel) {
      const split = result.splitChapters;
      const wasMerged = projectState.novel.chapters.length <= 1 && projectState.novel.chapters[0]?.title === "全文";
      if (wasMerged || split.length > 1) {
        // 新分章默认全部启用（不继承旧章节的 enabled，避免旧第 0 章被停用时所有新章全被停用）
        projectState.novel.chapters = split.map((c) => ({ ...c, enabled: c.enabled !== false }));
        logger.info("page", "分章结果已写入项目", { chapterCount: split.length, titles: split.map((c) => c.title).slice(0, 8) });
      }
    }
    if (opts.stages.includes("assemble")) {
      await checkVideos();
      await loadAssetMapNow(true);
    }
    if (opts.clearLogsFirst) tab.value = "cards";
    log({ step: "完成", message: `全部完成！项目输出到 ${result.meta.outputDir}，可前往「预览」页试玩`, level: "success", at: Date.now() });
    return true;
  } catch (e) {
    const msg = errMsg(e);
    logger.error("page", "生成失败", { message: msg });
    // 中途失败/中止也刷新素材：已增量落盘的图片保留并显示，重跑时只补缺失项
    void loadAssetMapNow(true);
    // 收回 Pipeline 已记录的失败任务，避免中止/崩溃后「失败项」丢失
    const failed = pipelineRef.value?.getFailedTasks?.() ?? [];
    if (failed.length) lastRunFailedTasks.value = failed;
    if (msg === "已中止") {
      logger.warn("page", "生成被用户中止");
      log({ step: "中止", message: t("已停止生成，进度已保存（缓存命中部分不会重复计费）"), level: "warn", at: Date.now() });
    } else {
      error.value = msg;
      log({ step: "错误", message: msg, level: "error", at: Date.now() });
    }
    return false;
  } finally {
    stopAssetLiveRefresh();
    busy.value = false;
    projectState.running = false;
    pipelineRef.value = null;
    activeRunLabels.value = [];
    void stageStatus.refresh();
    void chapterStatus.refresh();
  }
}

function start(): void {
  lastRunFailedTasks.value = [];
  void execute({ stages: selectedStagesList.value, clearLogsFirst: true });
}

function stageHint(s: string): string {
  switch (s) {
    case "split":
      return t("AI 识别章节边界（多文件合并/未切章时必开）");
    case "translate":
      return t("小说→目标语言（需 LLM）");
    case "extract":
      return t("角色/场景/物品卡");
    case "script":
      return t("分章分镜");
    case "image":
      return t("立绘/背景/CG/物品图");
    case "voice":
      return t("逐句配音");
    default:
      return t("写入游戏文件");
  }
}

async function prepareVisualBible(): Promise<void> {
  if (!projectState.novel) {
    error.value = t("请先导入小说或加载示例小说");
    return;
  }
  const selectedTextStages = selectedStagesList.value.filter((stage) =>
    ["split", "translate", "extract", "script"].includes(stage),
  );
  const stages = selectedTextStages.length
    ? selectedTextStages
    : (["split", "extract", "script"] as StageKey[]).filter((stage) => stage !== "translate");
  const prepared = await execute({ stages, clearLogsFirst: false });
  if (prepared || projectState.lastResult) tab.value = "bible";
}

async function resumeAfterVisualApproval(): Promise<void> {
  const stages = pendingResumeStages.value.length
    ? pendingResumeStages.value
    : resumeStagesAfterVisualApproval(selectedStagesList.value);
  if (!stages.length) {
    tab.value = "run";
    return;
  }
  await execute({ stages, clearLogsFirst: false });
  if (stages.includes("assemble")) {
    await checkVideos();
    await loadAssetMapNow(true);
  }
}

function onVisualBibleChanged(): void {
  void loadAssetMapNow(true);
}

/* ==================== 分阶段操作（统一入口 + 智能补漏） ==================== */

/**
 * 重新生成某个阶段：严格「单一阶段」语义——只跑点击的这一个阶段，不联动下游；
 * 缓存命中复用、只补缺失/失败项，不整批重跑；只有填写了意见才强制该阶段全量重生成
 * （分章除外：点击即重新分章）。下游如因上游变化而过期，需手动依次重跑下游，
 * 最后点「组装」刷新预览（组装为本地操作，不计费）。
 */
function runStageRegen(stage: StageKey): void {
  const fb = stageFeedback.value[stage]?.trim() || "";
  // 带意见即全量强制：执行前二次确认并明示影响（防"填一句意见烧掉全书"）
  if (!confirmStageOpinion(stage, fb)) return;
  const failedFor = failedTasks.value.filter((f) => stageStatus.STEP_TO_STAGE[f.step] === stage);
  const feedback = fb ? ({ [stage]: fb } as Partial<StageFeedback>) : undefined;
  const thenRefresh = (): void => {
    void stageStatus.refresh();
    void loadAssetMapNow(true);
  };
  const clearFb = (): void => {
    stageFeedback.value[stage] = "";
  };
  // 单阶段重跑后提示下游需手动跟进（仅上游数据变化时）：避免用户以为预览已自动更新
  const hintDownstreamStale = (label: string, downstream: string): void => {
    pushLog({
      step: label,
      message: `仅重跑了「${label}」，下游（${downstream}）未联动：旧结果已标记过期，需手动依次重跑下游，最后点「组装」刷新预览（组装免费）`,
      level: "warn",
      at: Date.now(),
    });
  };

  switch (stage) {
    case "split":
      // 分章无「补缺」概念：点击即重新分章。严格单阶段：下游按指纹自动过期，需手动重跑
      void execute({
        stages: ["split"],
        feedback: feedback as StageFeedback | undefined,
        forceStages: ["split"],
        rerunChapters: null,
      }).then((ok) => {
        clearFb();
        thenRefresh();
        if (ok) hintDownstreamStale("分章", "翻译 / 提取 / 剧本 / 图像 / 配音");
      });
      break;
    case "translate": {
      // 填了意见 → 全量重翻；否则「继续」：只补未缓存/失败的章节，已翻译的复用缓存
      // 严格单阶段：不联动提取/剧本/图像，下游过期需手动重跑
      const force = fb ? (["translate"] as StageKey[]) : undefined;
      void execute({
        stages: ["translate"],
        feedback: feedback as StageFeedback | undefined,
        forceStages: force,
        rerunChapters: null,
      }).then((ok) => {
        clearFb();
        thenRefresh();
        if (ok && fb) hintDownstreamStale("翻译", "提取 / 剧本 / 图像 / 配音");
      });
      break;
    }
    case "extract":
      // 填了意见 → 强制重提取（并作废下游剧本/立绘缓存）；否则复用缓存/补缺。
      // 严格单阶段：不自动重跑剧本/图像，下游过期需手动重跑，避免一次点击烧掉整套下游费用
      void execute({
        stages: ["extract"],
        feedback: feedback as StageFeedback | undefined,
        forceStages: fb ? (["extract"] as StageKey[]) : undefined,
        rerunChapters: null,
      }).then((ok) => {
        clearFb();
        thenRefresh();
        if (ok && fb) hintDownstreamStale("提取", "剧本 / 图像 / 配音");
      });
      break;
    case "script": {
      const failedChapters = failedFor
        .filter((f) => f.id.startsWith("chapter_"))
        .map((f) => parseInt(f.id.replace("chapter_", ""), 10) - 1);
      // 严格单阶段：只跑剧本，不自动补图/组装。新场景缺图时去「图像」点重新生成补齐，
      // 预览更新点「组装」（免费）。避免改一章剧本就把全书图片重跑一遍。
      const stages: StageKey[] = ["script"];
      if (fb) {
        const fbMap: Record<number, string> = {};
        for (const c of projectState.novel?.chapters ?? []) fbMap[c.index] = fb;
        void execute({ stages, feedback: { script: fbMap }, forceStages: ["script"], rerunChapters: null }).then((ok) => {
          void loadScripts();
          thenRefresh();
          if (ok) hintDownstreamStale("剧本", "图像 / 配音");
        });
      } else if (failedChapters.length) {
        // 只重生成失败章节，其余复用缓存
        void execute({ stages, rerunChapters: failedChapters }).then((ok) => {
          void loadScripts();
          thenRefresh();
          if (ok) hintDownstreamStale("剧本", "图像 / 配音");
        });
      } else {
        // 「继续」：全部章节复用缓存，缺缓存的补生成，不整批重写（避免白烧 LLM 费用）
        void execute({ stages, rerunChapters: null }).then(() => {
          void loadScripts();
          thenRefresh();
        });
      }
      clearFb();
      break;
    }
    case "image": {
      // 填了意见 → 全量重生成；否则「继续」：缓存命中复用、只补缺失/失败的图
      // 严格单阶段：不自动组装，预览更新手动点「组装」（免费）
      const force = fb ? (["image"] as StageKey[]) : undefined;
      void execute({
        stages: ["image"],
        feedback: feedback as StageFeedback | undefined,
        forceStages: force,
      }).then((ok) => {
        clearFb();
        thenRefresh();
        if (ok) {
          pushLog({
            step: "图像",
            message: "仅重跑了「图像」，如需更新预览请手动点「组装」（免费）",
            level: "info",
            at: Date.now(),
          });
        }
      });
      break;
    }
    case "voice": {
      // 填了意见 → 按意见全书重配（此前意见会被静默忽略）；否则「继续」只补缺失配音。
      // 严格单阶段，不自动组装
      const force = fb ? (["voice"] as StageKey[]) : undefined;
      void execute({ stages: ["voice"], feedback: feedback as StageFeedback | undefined, forceStages: force }).then((ok) => {
        thenRefresh();
        if (ok) {
          pushLog({
            step: "配音",
            message: "仅重跑了「配音」，如需更新预览请手动点「组装」（免费）",
            level: "info",
            at: Date.now(),
          });
        }
      });
      break;
    }
    case "assemble":
      void execute({ stages: ["assemble"] }).then(() => {
        void stageStatus.refresh();
      });
      break;
  }
}

/**
 * 单章节全链重跑（不含配音，为省 TTS 费用）：只动指定章节——
 * 剧本（默认只补缺失：有缓存直接复用；仅当填写了该章意见才按意见重写）、
 * 图像（仅该章背景/CG，其余复用映射；人物基础图已有成品的不重建任务）、组装（本地免费刷新预览）。
 * 带 requireFullScriptCoverage：其他章节缺缓存时在组装前中止，保护已有游戏不缩水。
 * 返回管线是否成功，供队列顺序调用。
 */
async function runChapterFullRegen(novelIdx: number): Promise<boolean> {
  const novel = projectState.novel;
  const ch = novel?.chapters.find((c) => c.index === novelIdx);
  if (!novel || !ch) {
    error.value = t("找不到该章节，请先导入小说");
    return false;
  }
  if (ch.enabled === false) {
    error.value = t("该章节已停用，请先启用再生成");
    return false;
  }
  if (!projectState.lastResult?.cards?.characters?.length) {
    error.value = t("还没有角色卡片，请先运行「提取」阶段（或一次全量流程），再逐章生成内容");
    return false;
  }
  // 视觉圣经未批准时跳过图像阶段，避免阻断剧本重生成（与原 regenChapter 同策略）
  const canFillImages = projectState.options.useImage && !visualBibleNeedsReview(projectState.visualBible);
  const fb = scriptChapterFeedback.value[novelIdx]?.trim() ?? "";
  // 只补缺失（默认）：无意见时不带 feedback key，管线优先复用该章剧本缓存、只生成缺失部分；
  // 只有填写了意见才强制按意见重写该章（scene.id 会变，该章图片随之重画）。
  // rerunChapters 限定单章，图像 scope 同口径过滤。
  const ok = await execute({
    stages: canFillImages ? (["script", "image", "assemble"] as StageKey[]) : (["script", "assemble"] as StageKey[]),
    feedback: fb ? { script: { [novelIdx]: fb } } : undefined,
    rerunChapters: [novelIdx],
    requireFullScriptCoverage: true,
  });
  scriptChapterFeedback.value[novelIdx] = "";
  void loadScripts();
  void loadAssetMapNow(true);
  void chapterStatus.refresh();
  if (ok) {
    pushLog({
      step: "单章",
      message: `第 ${novelIdx + 1} 章「${ch.title}」已重新生成（${fb ? "按意见重写剧本，" : ""}剧本${canFillImages ? "＋图像" : ""}只补缺失、不含配音；预览已组装）。配音请跑配音阶段或在素材页单句重配`,
      level: "success",
      at: Date.now(),
    });
  }
  return ok;
}

/** 带意见的阶段重跑二次确认：明示全量影响（张数/句数/章数），防"填一句意见烧掉全书"。
 * 无意见返回 true（直接执行"继续/补缺"语义）。 */
function confirmStageOpinion(stage: StageKey, fb: string): boolean {
  if (!fb) return true;
  const r = projectState.lastResult;
  const chapters = r?.chapters ?? [];
  const cards = r?.cards;
  const enabledNovelCount = projectState.novel?.chapters.filter((c) => c.enabled !== false).length ?? 0;
  switch (stage) {
    case "image": {
      let total = 0;
      let figs = 0;
      if (chapters.length && cards) {
        const tasks = buildImageTasks(chapters, cards, {
          figureEmotions: projectState.options.figureEmotions,
          detail: projectState.options.figureDetail ?? "full",
          threeView: projectState.options.characterPoses !== false,
          actions: projectState.options.characterPoses !== false,
          cgPerChapter: projectState.options.cgPerChapter ?? 0,
          maxPerChapter: projectState.options.imageBudgetPerChapter ?? 0,
        });
        total = tasks.filter((t) => t.kind !== "anchor").length;
        figs = tasks.filter((t) => t.kind === "figure" || t.kind === "threeview" || t.kind === "action").length;
      }
      return window.confirm(
        `「图像」意见将强制重画全书图片${total ? `约 ${total} 张（含人物基础图约 ${figs} 张）` : ""}，会产生图片费用。继续吗？\n（只想改单张图：去素材页点那张图的"重新生成"，意见填在那一区的意见框）`,
      );
    }
    case "script": {
      const n = enabledNovelCount || chapters.length;
      return window.confirm(
        `「剧本」意见将重写全书 ${n} 章剧本（旧场景图/配音随之过期需重跑）。继续吗？\n（只改一章：去章节盘点那一章的重新生成，意见填在该章意见框）`,
      );
    }
    case "extract":
      return window.confirm("「提取」意见将重新提取全部卡片，并作废下游剧本缓存与人物/物品图（背景/CG/配音文件保留）。继续吗？");
    case "translate": {
      const n = enabledNovelCount || chapters.length;
      return window.confirm(`「翻译」意见将重翻全书 ${n} 章。继续吗？`);
    }
    case "split":
      return window.confirm("将按意见重新分章：分章变化会导致下游剧本/图像/配音缓存过期需重跑。继续吗？");
    case "voice": {
      let n = 0;
      for (const ch of chapters) {
        for (const s of ch.scenes) {
          n += s.lines.length;
          for (const c of s.choices || []) n += c.lines.length;
        }
      }
      return window.confirm(
        `「配音」意见将全书重配${n ? `约 ${n} 句` : ""}，会产生配音费用。继续吗？\n（只重配一句/一人：去素材页配音区点单句重配或整人重配）`,
      );
    }
    default:
      return true;
  }
}

/* ==================== 纯追加式增量加更 ==================== */

const appendInput = ref<HTMLInputElement | null>(null);

/** 追加新章节：选一个 txt（第4章…），旧章节/卡片/素材全部保留，只对新增部分分章→生成 */
async function pickAppendFile(): Promise<void> {
  if (busy.value || assetBusy.value || queueRunning.value) return;
  const novel = projectState.novel;
  if (!novel?.fullText?.trim()) {
    error.value = t("追加需要原文全文：请先在「导入小说」页导入原小说（追加靠原文做前缀校验；仅加载项目目录不够）");
    return;
  }
  if (!projectState.lastResult) {
    error.value = t("请先完成一次生成（至少跑完分章与提取），再追加新章节");
    return;
  }
  if (!isTauri()) {
    appendInput.value?.click();
    return;
  }
  const picked = await open({ multiple: false, filters: [{ name: t("文本文件"), extensions: ["txt", "TXT"] }] });
  if (!picked || typeof picked !== "string") return;
  try {
    const { text } = await tauri.readTextFile(picked);
    await runAppend(text, picked);
  } catch (e) {
    error.value = errMsg(e);
  }
}

async function onAppendFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    await runAppend(await file.text(), file.name);
  } catch (err) {
    error.value = errMsg(err);
  }
}

async function runAppend(tailRaw: string, label: string): Promise<void> {
  const novel = projectState.novel;
  if (!novel?.fullText?.trim()) return;
  const tail = tailRaw.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!tail) {
    error.value = t("追加文件为空，已取消");
    return;
  }
  if (tail.length < 500 && !window.confirm(`新增内容仅 ${tail.length} 字（不足半章），仍要追加吗？`)) return;
  const fileName = label.split(/[\\/]/).pop() || label;
  if (!window.confirm(
    `增量追加：在现有 ${novel.chapters.length} 章（约 ${novel.fullText.length} 字）后追加「${fileName}」（约 ${tail.length} 字）。\n旧章节、卡片与全部素材原样保留，只对新增部分分章→提取→生成新章。继续吗？`,
  )) return;
  const stages: StageKey[] = ["split", "extract", "script", "image", "assemble"];
  if ((projectState.options.language ?? "").trim()) stages.splice(1, 0, "translate");
  if (projectState.options.useImage && visualBibleNeedsReview(projectState.visualBible)) {
    // 圣经待确认时不进图像阶段（避免流程被 divert 到圣经页导致追加上下文丢失）：
    // 先追加文本，图像待圣经确认后跑一次图像阶段即可自动补上新章（缓存复用旧图）
    stages.splice(stages.indexOf("image"), 1);
    pushLog({ step: "追加", message: "视觉圣经待确认，本次先追加文本（分章/提取/剧本），图像待圣经确认后跑「图像」阶段自动补新章", level: "warn", at: Date.now() });
  }
  const ok = await execute({
    stages,
    append: { baseFullText: novel.fullText, tailText: tail },
    requireFullScriptCoverage: true,
  });
  if (ok) {
    // 更新内存小说：全文拼接 + 分章以管线返回为准；追加文件路径记入 sourcePaths 以便重启后恢复
    const newFull = joinAppendText(novel.fullText, tail);
    const splitChapters = projectState.lastResult?.splitChapters;
    novel.fullText = newFull;
    if (splitChapters?.length) novel.chapters = splitChapters;
    if (/^[a-zA-Z]:[\\/]/.test(label) || label.startsWith("/")) {
      const paths = novel.sourcePaths?.length ? [...novel.sourcePaths] : (novel.sourcePath ? [novel.sourcePath] : []);
      if (!paths.includes(label)) paths.push(label);
      novel.sourcePaths = paths;
    }
    scheduleSave();
    void chapterStatus.refresh();
    pushLog({ step: "追加", message: `增量追加完成：现共 ${novel.chapters.length} 章；新章节配音请跑配音阶段（勾选新章节）或在素材页单句重配`, level: "success", at: Date.now() });
  }
}

function regenChapter(idx: number): void {
  // 剧本页的"重新生成此章"即单章节全链（与章节盘一致）
  void runChapterFullRegen(idx);
}

/* ==================== 素材 Tab 操作 ==================== */

async function regenCtx(): Promise<RegenContext | null> {
  if (busy.value || assetBusy.value) return null;
  const r = projectState.lastResult;
  if (!r) return null;
  const imageCfg = activeConfig("image");
  const ttsCfg = activeConfig("tts");
  const visionCfg = activeConfig("vision");
  const llmCfg = activeConfig("llm");
  if (projectState.options.imageSelfCheck && !configIsUsable(visionCfg, "vision")) {
    pushLog({
      step: "图片识别",
      message: t("图像自检已启用，但图片识别 API 未配置或不可用；请先在「API 配置」页完成配置"),
      level: "error",
      at: Date.now(),
    });
    return null;
  }
  return {
    cfg: projectState.options.useImage && imageCfg?.apiKey ? imageCfg : undefined,
    // 手动重配配音不依赖 useTts 开关：只要配置了 TTS 且有卡片即可
    ttsCfg: ttsCfg?.apiKey ? ttsCfg : undefined,
    chapters: r.chapters,
    cards: r.cards,
    materials: projectState.materials,
    outputDir: projectState.outputDir,
    log: (ev) => pushLog(ev),
    style: projectState.options.imageStyle || undefined,
    figureEmotions: projectState.options.figureEmotions,
    figureDetail: projectState.options.figureDetail ?? "full",
    threeView: projectState.options.characterPoses !== false,
    actions: projectState.options.characterPoses !== false,
    verifyCfg: projectState.options.imageSelfCheck ? visionCfg : undefined,
    visionCfg: configIsUsable(visionCfg, "vision") ? visionCfg : undefined,
    safeRewriteCfg: configIsUsable(llmCfg, "llm") ? llmCfg : undefined,
    imageSeed: projectState.options.imageSeed || undefined,
    styleAnchor: projectState.options.styleAnchor,
    visualBible: projectState.visualBible?.status === "approved" ? projectState.visualBible : undefined,
  };
}

async function afterAssetRegen(label: string, resultsLength: number): Promise<void> {
  pushLog({ step: "素材", message: `${label}：已重新生成 ${resultsLength} 项，正在重新组装…`, level: "success", at: Date.now() });
  assetBusy.value = "";
  await execute({ stages: ["assemble"] });
  await loadAssetMapNow(true);
}

async function regenFigureEmotion(charId: string, emo: string): Promise<void> {
  const ctx = await regenCtx();
  if (!ctx) return;
  const fb = assetFeedback.value.figure?.trim() || undefined;
  assetBusy.value = `figure:${charId}:${emo}`;
  resetRegenState();
  try {
    const { signal, onProgress } = regenCtl();
    const results = await regenerateImages(
      ctx,
      (t) => t.kind === "figure" && (emo === "normal" ? t.id === charId : t.id === `${charId}_${emo}`),
      fb,
      signal,
      onProgress,
    );
    await afterAssetRegen(`立绘「${charId}」${EMOTION_LABELS[emo] ?? emo}`, results.length);
  } catch (e) {
    pushLog({ step: "素材", message: `重新生成立绘失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    assetFeedback.value.figure = "";
    resetRegenState();
  }
}

async function regenAllFigure(charId: string): Promise<void> {
  const ctx = await regenCtx();
  if (!ctx) return;
  const fb = assetFeedback.value.figure?.trim() || undefined;
  assetBusy.value = `figure:${charId}`;
  resetRegenState();
  try {
    const { signal, onProgress } = regenCtl();
    const results = await regenerateCharacterFigures(ctx, charId, fb, signal, onProgress);
    await afterAssetRegen(`立绘「${charId}」（全部表情）`, results.length);
  } catch (e) {
    pushLog({ step: "素材", message: `重新生成立绘失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    assetFeedback.value.figure = "";
    resetRegenState();
  }
}

async function regenThreeView(charId: string): Promise<void> {
  const ctx = await regenCtx();
  if (!ctx) return;
  const fb = assetFeedback.value.figure?.trim() || undefined;
  assetBusy.value = `threeview:${charId}`;
  resetRegenState();
  try {
    const { signal, onProgress } = regenCtl();
    const results = await regenerateCharacterThreeView(ctx, charId, fb, signal, onProgress);
    await afterAssetRegen(`三视图「${charId}」（联动重生成默认/表情/动作）`, results.length);
  } catch (e) {
    pushLog({ step: "素材", message: `重新生成三视图失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    assetFeedback.value.figure = "";
    resetRegenState();
  }
}

async function regenAction(charId: string, actionId: string, actionName: string): Promise<void> {
  const ctx = await regenCtx();
  if (!ctx) return;
  const fb = assetFeedback.value.figure?.trim() || undefined;
  assetBusy.value = `action:${charId}:${actionId}`;
  resetRegenState();
  try {
    const { signal, onProgress } = regenCtl();
    const results = await regenerateCharacterAction(ctx, charId, actionId, fb, signal, onProgress);
    await afterAssetRegen(`动作「${actionName}」（${charId}）`, results.length);
  } catch (e) {
    pushLog({ step: "素材", message: `重新生成动作失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    assetFeedback.value.figure = "";
    resetRegenState();
  }
}

async function regenItem(id: string): Promise<void> {
  const ctx = await regenCtx();
  if (!ctx) return;
  const fb = assetFeedback.value.item?.trim() || undefined;
  assetBusy.value = `item:${id}`;
  resetRegenState();
  try {
    const { signal, onProgress } = regenCtl();
    const results = await regenerateItemImage(ctx, id, fb, signal, onProgress);
    await afterAssetRegen(`物品图「${id}」`, results.length);
  } catch (e) {
    pushLog({ step: "素材", message: `重新生成物品图失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    assetFeedback.value.item = "";
    resetRegenState();
  }
}

async function regenBg(sceneId: string): Promise<void> {
  const ctx = await regenCtx();
  if (!ctx) return;
  const fb = assetFeedback.value.bg?.trim() || undefined;
  assetBusy.value = `bg:${sceneId}`;
  resetRegenState();
  try {
    const { signal, onProgress } = regenCtl();
    const results = await regenerateBackground(ctx, sceneId, fb, signal, onProgress);
    await afterAssetRegen(`背景「${sceneId}」`, results.length);
  } catch (e) {
    pushLog({ step: "素材", message: `重新生成背景失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    assetFeedback.value.bg = "";
    resetRegenState();
  }
}

async function regenCgRow(chapter: number, sceneId: string): Promise<void> {
  const ctx = await regenCtx();
  if (!ctx) return;
  const fb = assetFeedback.value.cg?.trim() || undefined;
  assetBusy.value = `cg:${chapter}:${sceneId}`;
  resetRegenState();
  try {
    const { signal, onProgress } = regenCtl();
    const results = await regenerateCg(ctx, chapter - 1, sceneId, fb, signal, onProgress);
    await afterAssetRegen(`CG「${sceneId}」`, results.length);
  } catch (e) {
    pushLog({ step: "素材", message: `重新生成 CG 失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    assetFeedback.value.cg = "";
    resetRegenState();
  }
}

const audioRef = ref<HTMLAudioElement | null>(null);
const playingVoiceKey = ref("");

async function playVoice(key: string, file: string): Promise<void> {
  if (playingVoiceKey.value === key) {
    playingVoiceKey.value = "";
    if (audioRef.value) audioRef.value.pause();
    return;
  }
  const src = await ensureAssetLoaded(file);
  if (!src) {
    pushLog({ step: "素材", message: t("读取配音文件失败"), level: "warn", at: Date.now() });
    return;
  }
  playingVoiceKey.value = key;
  await nextTick();
  if (audioRef.value) {
    audioRef.value.src = src;
    void audioRef.value.play().catch(() => {
      pushLog({ step: "素材", message: t("试听播放失败（可能音频编码不支持）"), level: "warn", at: Date.now() });
    });
  }
}

async function regenVoice(key: string): Promise<void> {
  const ctx = await regenCtx();
  if (!ctx) return;
  if (!ctx.ttsCfg) {
    pushLog({
      step: "素材",
      message: t("配音（TTS）未启用或未配置 API，无法重新配音。请在「API 配置」页配置 TTS 服务，并在生成设置中勾选「配音（TTS）」"),
      level: "warn",
      at: Date.now(),
    });
    return;
  }
  assetBusy.value = `voice:${key}`;
  resetRegenState();
  try {
    const p = await regenerateVoiceLine(ctx, key);
    pushLog(
      {
        step: "素材",
        message: p ? `配音已重新生成：${key}` : `配音重新生成失败或未找到：${key}`,
        level: p ? "success" : "warn",
        at: Date.now(),
      },
    );
    assetBusy.value = "";
    await execute({ stages: ["assemble"] });
  } catch (e) {
    pushLog({ step: "素材", message: `重新配音失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    resetRegenState();
    await loadAssetMapNow(true);
  }
}

async function regenCharVoice(charId: string): Promise<void> {
  const ctx = await regenCtx();
  if (!ctx) return;
  if (!ctx.ttsCfg) {
    pushLog({
      step: "素材",
      message: t("配音（TTS）未启用或未配置 API，无法重新配音。请在「API 配置」页配置 TTS 服务，并在生成设置中勾选「配音（TTS）」"),
      level: "warn",
      at: Date.now(),
    });
    return;
  }
  assetBusy.value = `voice-all:${charId}`;
  resetRegenState();
  try {
    const { signal, onProgress } = regenCtl();
    const n = await regenerateCharacterVoice(ctx, charId, signal, onProgress);
    pushLog({ step: "素材", message: `角色「${charId}」全部配音已重新生成 ${n} 句`, level: "success", at: Date.now() });
    assetBusy.value = "";
    await execute({ stages: ["assemble"] });
  } catch (e) {
    pushLog({ step: "素材", message: `重新配音失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    resetRegenState();
    await loadAssetMapNow(true);
  }
}

/** 补全缺失/错配语音：按当前剧本逐句核对映射与磁盘文件，缺的重配、错配的替换，
 * 并清理不再被引用的孤儿语音文件（修复上次历史遗留的结构问题，无需手工删目录）。 */
async function regenMissingVoices(): Promise<void> {
  const ctx = await regenCtx();
  if (!ctx) return;
  if (!ctx.ttsCfg) {
    pushLog({
      step: "素材",
      message: t("配音（TTS）未启用或未配置 API，无法补全语音。请在「API 配置」页配置 TTS 服务"),
      level: "warn",
      at: Date.now(),
    });
    return;
  }
  assetBusy.value = "repair-voice";
  resetRegenState();
  try {
    const r = await repairVoiceAssets(ctx.ttsCfg, ctx.chapters, ctx.cards.characters, ctx.outputDir, ctx.log);
    if (r.fixed > 0) {
      pushLog({
        step: "素材",
        message: `补全缺失语音完成：检查 ${r.total} 句，重配 ${r.fixed} 句，失败 ${r.failed}，清理孤儿文件 ${r.purged} 个；正在重新组装…`,
        level: r.failed ? "warn" : "success",
        at: Date.now(),
      });
      assetBusy.value = "";
      await execute({ stages: ["assemble"] });
    } else {
      pushLog({
        step: "素材",
        message: `配音结构健康：${r.total} 句全部与当前剧本一致，无需重配${r.purged ? `（顺手清理孤儿文件 ${r.purged} 个）` : ""}`,
        level: "success",
        at: Date.now(),
      });
    }
  } catch (e) {
    pushLog({ step: "素材", message: `补全缺失语音失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    resetRegenState();
    await loadAssetMapNow(true);
  }
}

/** 清理无效素材：剪掉过期映射、迁移旧版 CG、删除孤儿文件、清理缺文件映射。
 * 只有在剧本上下文完整（素材页章节数对得上原文启用章节数）时才剪 bg/cg/人物映射，
 * 否则只做文件级清理（删孤儿、迁旧 CG、去缺文件条目），绝不误删。 */
async function cleanupInvalidAssets(): Promise<void> {
  const ctx = await regenCtx();
  if (!ctx) return;
  const novelCount = projectState.novel?.chapters.filter((c) => c.enabled !== false).length ?? 0;
  const chaptersComplete = novelCount > 0 && ctx.chapters.length >= novelCount;
  if (!window.confirm(chaptersComplete
    ? "将清理无效图片素材：过期映射剪枝、旧版 CG 迁移、孤儿文件删除。缺失项稍后自动补生成，继续吗？"
    : "当前剧本上下文不完整（素材页章节少于原文），本次只做文件级清理（删孤儿文件、迁移旧版 CG），不剪映射。继续吗？")) return;
  assetBusy.value = "cleanup-images";
  resetRegenState();
  try {
    const r = await repairImageAssets(ctx.outputDir, {
      chapters: chaptersComplete ? ctx.chapters : undefined,
      cards: ctx.cards,
      figureEmotions: ctx.figureEmotions ?? true,
      figureDetail: ctx.figureDetail ?? "full",
      threeView: ctx.threeView !== false,
      withActions: ctx.actions !== false,
      maxPerChapter: projectState.options.imageBudgetPerChapter ?? 0,
      cgPerChapter: projectState.options.cgPerChapter ?? 0,
    }, ctx.log);
    pushLog({
      step: "素材",
      message: `清理完成：剪枝 ${r.prunedRefs} 项，迁移旧版 CG ${r.migratedCg} 项，删除孤儿文件 ${r.purgedFiles} 个，清理缺文件映射 ${r.missingDropped} 项；正在重新组装…`,
      level: "success",
      at: Date.now(),
    });
    assetBusy.value = "";
    await execute({ stages: ["assemble"] });
  } catch (e) {
    pushLog({ step: "素材", message: `清理无效素材失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    resetRegenState();
    await loadAssetMapNow(true);
  }
}

/* ==================== 原有功能 ==================== */

async function browseOutputDir(): Promise<void> {
  if (!isTauri()) {
    outputDirDraft.value = await tauri.getDefaultOutputDir();
    pushLog({ step: "项目", message: t("Web 版输出目录固定为虚拟目录 /app/exports"), level: "info", at: Date.now() });
    return;
  }
  const dir = await open({ directory: true, multiple: false });
  if (dir && typeof dir === "string") {
    outputDirDraft.value = dir;
  }
}

async function loadProjectState(): Promise<void> {
  const dir = outputDirDraft.value.trim();
  if (!dir) return;
  await restoreProject(dir);
  configState.outputDir = dir;
  addRecentOutputDir(dir);
  pushLog({ step: "项目", message: `已加载项目状态：${dir}`, level: "success", at: Date.now() });
  await stageStatus.refresh();
}

/**
 * 生成期间让素材页有可用的结构（lastResult 缺 chapters/cards 时从磁盘补上）。
 * 只读磁盘，不覆盖 projectState.options/novel 等运行态，避免影响本次生成参数。
 * 目的：图片每生成一张（assets.json 增量写入）就能在素材页即时显示，无需等整批生成完。
 * 只要磁盘上已有 cards.json / 剧本缓存，就始终以磁盘为准刷新结构：
 * 提取阶段写完 cards.json、剧本阶段每章写完缓存后，素材页行结构即时跟上
 * （覆盖首次运行、中止后、以及重跑剧本导致结构变化三种场景）。
 */
async function ensureLiveResultShape(outputDir: string): Promise<void> {
  try {
    if (!projectState.lastResult) {
      projectState.lastResult = {
        meta: {
          title: "",
          gameKey: "",
          chapterCount: 0,
          charCount: 0,
          sceneCount: 0,
          lineCount: 0,
          outputDir,
          webgalVersion: "",
          generatedAt: "",
        },
        cards: { title: "", characters: [], scenes: [], items: [] },
        cost: { llmTokens: 0, imageCount: 0, ttsChars: 0, llmCostYuan: 0, imageCostYuan: 0, ttsCostYuan: 0 },
        chapters: [],
        assets: {},
        failedTasks: [],
      };
    }
    const cardsFile = `${outputDir}/.novel2vn/cards.json`;
    if (await tauri.pathExists(cardsFile)) {
      const { text } = await tauri.readTextFile(cardsFile);
      const cards = JSON.parse(text) as import("../core/types").ExtractionResult;
      if (Array.isArray(cards.characters)) projectState.lastResult.cards = cards;
    }
    const entries = await tauri.listDir(`${outputDir}/.novel2vn/cache`).catch(() => [] as { name: string; path: string; isDir: boolean }[]);
    const files = entries
      .filter((e) => !e.isDir && /^script(_demo)?_ch\d+_/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (files.length) {
      const chapters: import("../core/types").ChapterScript[] = [];
      for (const f of files) {
        try {
          const { text } = await tauri.readTextFile(f.path);
          const sc = parseChapterScript(JSON.parse(text));
          chapters[sc.chapter] = sc;
        } catch {
          /* 跳过损坏缓存 */
        }
      }
      projectState.lastResult.chapters = chapters.filter(Boolean);
    }
  } catch {
    /* 恢复失败不阻断生成 */
  }
}

/** 节流版结构同步：进度事件密集（每张图一条）时最多每 2s 同步一次 */
let lastShapeSyncAt = 0;
function syncLiveResultShape(): void {
  const now = Date.now();
  if (now - lastShapeSyncAt < 2000) return;
  lastShapeSyncAt = now;
  if (projectState.outputDir) void ensureLiveResultShape(projectState.outputDir);
}

async function checkVideos(): Promise<void> {
  const out = projectState.outputDir;
  if (!out) return;
  videoStatus.value = {};
  try {
    const entries = await tauri.listDir(`${out}/game/video`);
    for (const e of entries) {
      const m = e.name.match(/^video_(.+)\.(mp4|webm|ogg)$/i);
      if (m) videoStatus.value[m[1]] = true;
    }
  } catch {
    /* 目录不存在 */
  }
}

/** 导入视频到 AI 推荐演出位：按 video_<id>.<ext> 命名放入 game/video/ */
async function importVideo(vp: { id: string; title: string }): Promise<void> {
  const out = projectState.outputDir;
  if (!out) return;
  try {
    if (!isTauri()) {
      videoImportTarget.value = vp;
      videoInput.value?.click();
      return;
    }
    const picked = await open({
      multiple: false,
      filters: [{ name: t("视频"), extensions: ["mp4", "webm", "ogg"] }],
    });
    if (!picked || typeof picked !== "string") return;
    const ext = (picked.match(/\.([a-z0-9]+)$/i)?.[1] ?? "mp4").toLowerCase();
    const dst = `${out}/game/video/video_${sanitizeId(vp.id)}.${ext}`;
    await tauri.mkdirAll(`${out}/game/video`).catch(() => {});
    await tauri.copyFile(picked, dst);
    pushLog({ step: "视频", message: `已导入视频：video_${sanitizeId(vp.id)}.${ext}（${vp.title}）`, level: "success", at: Date.now() });
    await checkVideos();
  } catch (e) {
    pushLog({ step: "视频", message: `导入视频失败：${errMsg(e)}`, level: "error", at: Date.now() });
  }
}

/** Web 模式：文件选择后写入虚拟文件系统 */
async function onVideoImportFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const vp = videoImportTarget.value;
  videoImportTarget.value = null;
  const out = projectState.outputDir;
  if (!file || !vp || !out) return;
  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "mp4").toLowerCase();
  const dst = `${out}/game/video/video_${sanitizeId(vp.id)}.${ext}`;
  try {
    const b64 = await fileToBase64(file);
    await vfsWriteFileBase64(dst, b64);
    pushLog({ step: "视频", message: `已导入视频：video_${sanitizeId(vp.id)}.${ext}（${vp.title}）`, level: "success", at: Date.now() });
    await checkVideos();
  } catch (err) {
    pushLog({ step: "视频", message: `导入视频失败：${errMsg(err)}`, level: "error", at: Date.now() });
  }
}

async function loadScripts(): Promise<void> {
  const out = projectState.outputDir;
  if (!out) return;
  try {
    const entries = await tauri.listDir(`${out}/game/scene`);
    const files: { name: string; text: string }[] = [];
    for (const e of entries) {
      if (!e.name.endsWith(".txt")) continue;
      const { text } = await tauri.readTextFile(e.path);
      files.push({ name: e.name, text });
    }
    scriptFiles.value = files.sort((a, b) => a.name.localeCompare(b.name));
    if (files.length && !currentScript.value) currentScript.value = files[0].name;
  } catch {
    scriptFiles.value = [];
  }
}

async function copyText(text: string, label: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  copiedMsg.value = `${label}已复制`;
  setTimeout(() => (copiedMsg.value = ""), 2000);
}

async function copyLogs(): Promise<void> {
  const text = projectState.logs
    .map((l) => `[${new Date(l.at).toLocaleTimeString()}] [${l.step}] ${l.message}`)
    .join("\n");
  await navigator.clipboard.writeText(text);
  copiedMsg.value = t("日志已复制");
  setTimeout(() => (copiedMsg.value = ""), 2000);
}

async function saveLogs(): Promise<void> {
  const out = projectState.outputDir;
  if (!out) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = `${out}/.novel2vn/logs/${stamp}.log`;
  const text = [
    `NovelForge 生成日志 ${stamp}`,
    `项目：${out}`,
    `失败项：${failedTasks.value.length} 个`,
    "",
    "== 界面日志 ==",
    ...projectState.logs.map((l) => `[${new Date(l.at).toLocaleTimeString()}] [${l.step}] ${l.message}`),
    "",
    "== 详细诊断日志 ==",
    dumpLogHistory(),
  ].join("\n");
  try {
    await tauri.writeTextFile(path, text);
    logger.info("page", "日志已保存", { path });
    copiedMsg.value = `日志已保存：${path}`;
  } catch (e) {
    copiedMsg.value = `保存失败：${errMsg(e)}`;
  }
  setTimeout(() => (copiedMsg.value = ""), 3000);
}

async function retryFailed(): Promise<void> {
  const failed = failedTasks.value;
  if (!failed.length) return;
  const chapterIds = new Set<number>();
  for (const f of failed) {
    if (f.kind === "script" && f.id.startsWith("chapter_")) {
      chapterIds.add(parseInt(f.id.replace("chapter_", ""), 10) - 1);
    }
  }
  if (chapterIds.size) {
    rerunChapters.value = Array.from(chapterIds);
    copiedMsg.value = t("已定位失败章节，请点右侧「去整书生成」再点开始，将只重试失败项（其余自动复用缓存）");
  } else {
    copiedMsg.value = t("失败项为图片/翻译类：请点右侧「去整书生成」再点开始重跑对应阶段，已完成的自动复用缓存、只补失败项");
  }
  setTimeout(() => (copiedMsg.value = ""), 4000);
}

const rerunChapters = ref<number[] | null>(null);

function toggleAllRerun(on: boolean): void {
  if (!projectState.novel) return;
  rerunChapters.value = on ? null : [];
}

function toggleChapterRerun(index: number, checked: boolean): void {
  if (checked) {
    if (!rerunChapters.value) rerunChapters.value = [];
    if (!rerunChapters.value.includes(index)) rerunChapters.value.push(index);
  } else {
    if (rerunChapters.value) {
      rerunChapters.value = rerunChapters.value.filter((n) => n !== index);
    } else {
      rerunChapters.value = projectState.novel?.chapters.map((c) => c.index).filter((n) => n !== index) ?? [];
    }
  }
}

function stop(): void {
  pipelineRef.value?.abort();
  error.value = "";
  pushLog({ step: "中止", message: t("用户请求中止，当前任务完成后将停止"), level: "warn", at: Date.now() });
}

function onCardsSaved(cards: unknown): void {
  if (projectState.lastResult) {
    projectState.lastResult.cards = cards as never;
  }
  scheduleSave();
}

function fileExistsLabel(file: string | undefined): string {
  return file ? t("已生成") : t("未生成");
}
</script>

<template>
  <div class="inner">
    <PageHead :title="t('生成项目')" :sub="t('三种执行方式：整书生成 / 单阶段重跑 / 单章节生成。先在上方选方式，再看下方运行与内容。')">
      <button class="btn" :disabled="busy || !!assetBusy" @click="start">
        <span v-if="busy" class="spinner" />
        {{ busy ? t("生成中…") : t("开始生成") }}
      </button>
      <button v-if="busy" class="btn danger" @click="stop">{{ t("停止") }}</button>
    </PageHead>

    <div v-if="visualBibleReviewNeeded" class="vb-banner">
      <div>
        <strong>{{ t("图像生成前需要确认视觉圣经") }}</strong>
        <p>{{ t("统一风格与角色三视图尚未批准，图像阶段会先停在这里。") }}</p>
      </div>
      <button class="btn secondary small" @click="tab = 'bible'">{{ t("去确认") }}</button>
    </div>

    <div v-if="busy || currentStep >= 0" class="mb-4">
      <StepIndicator :steps="pipelineSteps" :current="currentStep" :failed="failedSteps" />
    </div>

    <div class="card">
      <div class="card-head">
        <h3>{{ t("执行方式") }}</h3>
        <div class="card-actions">
          <span class="hint">{{ runModeHint }}</span>
        </div>
      </div>
      <div class="row">
        <button :class="runMode === 'full' ? 'btn small' : 'btn secondary small'" @click="runMode = 'full'">{{ t("整书生成") }}</button>
        <button :class="runMode === 'stage' ? 'btn small' : 'btn secondary small'" @click="runMode = 'stage'">{{ t("单阶段重跑") }}</button>
        <button :class="runMode === 'chapter' ? 'btn small' : 'btn secondary small'" @click="runMode = 'chapter'">{{ t("单章节生成") }}</button>
      </div>
    </div>

    <div class="card">
      <label class="field mb-0">
        <span>{{ t("输出目录") }}</span>
        <div class="row">
          <input type="text" v-model="outputDirDraft" class="grow" />
          <button class="btn secondary small shrink-0" @click="browseOutputDir">{{ t("浏览…") }}</button>
          <button class="btn ghost small shrink-0" @click="loadProjectState">{{ t("加载该项目") }}</button>
        </div>
      </label>
    </div>

    <details class="card" :open="!projectState.lastResult">
      <summary class="card-head"><h3>{{ t("生成内容") }}</h3></summary>

      <div class="opt-grid">
        <label class="opt-item">
          <input type="checkbox" v-model="projectState.options.useImage" /> {{ t("图像（立绘/背景/CG/物品）") }}
        </label>
        <label class="opt-item" :title="t('关闭则每角色只生成默认表情')">
          <input type="checkbox" v-model="projectState.options.figureEmotions" /> {{ t("表情差分") }}
        </label>
        <label class="opt-item" :title="t('核心档：标准5表情、无服装差分，省图省钱；完整档：AI全量表情＋服装＋动作')">
          <span>{{ t("人物图详细度") }}</span>
          <select v-model="projectState.options.figureDetail">
            <option value="full">{{ t("完整（默认）") }}</option>
            <option value="core">{{ t("核心（省图）") }}</option>
          </select>
        </label>
        <label class="opt-item">
          <input type="checkbox" v-model="projectState.options.figureActions" /> {{ t("人物动作（入场/情绪动作/镜头震动）") }}
        </label>
        <label class="opt-item" :title="t('图生图，形象更一致')">
          <input type="checkbox" v-model="projectState.options.characterPoses" /> {{ t("角色三视图与动作立绘") }}
        </label>
        <label class="opt-item">
          <input type="checkbox" v-model="projectState.options.useTts" /> {{ t("配音（TTS）") }}
        </label>
        <label class="opt-item">
          <input type="checkbox" v-model="projectState.options.useVideoPoints" /> {{ t("视频推荐位") }}
        </label>
        <label class="opt-item">
          <input type="checkbox" v-model="projectState.options.useBgm" /> {{ t("BGM 匹配") }}
        </label>
        <label class="opt-item">
          <input type="checkbox" v-model="projectState.options.characterIntroCard" /> {{ t("角色登场资料卡") }}
        </label>
      </div>

      <div class="card-section">
        <div class="field-grid">
          <label class="field">
            <span>{{ t("目标语言（先把小说翻译成该语言再生成，留空 = 用原文）") }}</span>
            <select v-model="projectState.options.language">
              <option value="">{{ t("不翻译（使用原文）") }}</option>
              <option v-for="l in LANGUAGES" :key="l.code" :value="l.code">{{ l.label }}</option>
            </select>
          </label>
          <label class="field">
            <span>{{ t("统一画风（留空用默认画风，所有立绘/背景/CG 保持一致）") }}</span>
            <input
              type="text"
              v-model="projectState.options.imageStyle"
              :placeholder="t('例：unified Japanese anime style, cel shading, clean line art')"
            />
          </label>
          <label class="field">
            <span>{{ t("剧本风格（留空不调整。例：古风典雅 / 幽默风趣 / 冷峻克制）") }}</span>
            <input type="text" v-model="projectState.options.scriptStyle" :placeholder="t('例：古风典雅，多用对仗与典雅意象')" />
          </label>
        </div>
        <div class="field-grid mt-3">
          <label class="field">
            <span>{{ t("风格参考图（上传图片 → AI 识别画风并自动填入上方）") }}</span>
            <div class="row">
              <button class="btn secondary small" :disabled="styleRecognizing" @click="pickStyleRef">
                <span v-if="styleRecognizing" class="spinner" />
                {{ styleRecognizing ? t("AI 识别中…") : styleRefSrc ? t("更换图片并重新识别") : t("上传图片，AI 识别画风") }}
              </button>
              <span v-if="styleRefSrc" class="tag ok">{{ t("已识别") }}</span>
              <button v-if="styleRefSrc" class="btn ghost small" @click="styleRefSrc = ''">{{ t("清除") }}</button>
              <input ref="styleRefInput" type="file" accept="image/*" style="display: none" @change="onStyleRefFile" />
            </div>
          </label>
          <div v-if="styleRefSrc" class="field" style="justify-self: start">
            <span>&nbsp;</span>
            <img
              :src="styleRefSrc"
              :alt="t('风格参考图')"
              style="width: 72px; height: 72px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border)"
            />
          </div>
        </div>
      </div>

      <details class="adv">
        <summary>{{ t("高级设置") }}</summary>
        <div class="opt-grid">
          <label class="opt-item" :title="t('先生成一张全项目画风基准图，背景/CG 以其为参考图，强制所有图片画风统一（推荐开启）')">
            <input type="checkbox" v-model="projectState.options.styleAnchor" /> {{ t("风格锚点（背景/CG 统一画风）") }}
          </label>
          <label class="opt-item" :title="t('使用独立图片识别 API 核对生成图，不合格自动重生成 1 次（会增加费用与耗时）')">
            <input type="checkbox" v-model="projectState.options.imageSelfCheck" /> {{ t("图像自检（多模态核对，不合格自动重生成）") }}
          </label>
          <label class="opt-item">
            <input type="checkbox" v-model="projectState.options.skipCache" /> {{ t("跳过缓存（全量重跑）") }}
          </label>
        </div>
        <div class="field-grid">
          <label class="field">
            <span>{{ t("每章 CG 数上限") }}（0 = {{ t("不限制") }}）</span>
            <input type="number" v-model.number="projectState.options.cgPerChapter" min="0" placeholder="0" />
          </label>
          <label class="field">
            <span>{{ t("每章图像数上限") }}（0 = {{ t("不限制") }}）</span>
            <input type="number" v-model.number="projectState.options.imageBudgetPerChapter" min="0" placeholder="0" />
          </label>
          <label class="field">
            <span>{{ t("视频推荐点数上限") }}（0 = {{ t("不限制") }}）</span>
            <input type="number" v-model.number="projectState.options.videoPointsPerChapter" min="0" placeholder="0" />
          </label>
          <label class="field" :title="t('固定所有图片生成的随机种子：同一种子下背景/CG/立绘的画风与角色更稳定一致。0 = 按小说标题自动派生')">
            <span>{{ t("固定种子（0 = 按标题自动派生）") }}</span>
            <input type="number" v-model.number="projectState.options.imageSeed" min="0" />
          </label>
        </div>
      </details>
    </details>

    <div class="card" v-if="runMode === 'full'">
      <div class="card-head">
        <h3>{{ t("本次执行阶段") }}</h3>
        <div class="card-actions">
          <button class="btn ghost small" @click="selectedStages = { split: true, translate: true, extract: true, script: true, image: true, voice: true, assemble: true }">{{ t("全选") }}</button>
          <button class="btn ghost small" @click="selectedStages = { split: false, translate: false, extract: false, script: false, image: false, voice: false, assemble: false }">{{ t("全不选") }}</button>
        </div>
      </div>
      <div class="opt-grid">
        <label v-for="s in STAGE_ORDER" :key="s" class="opt-item" :title="stageHint(s)">
          <input type="checkbox" v-model="selectedStages[s]" />
          {{ t(STAGE_LABELS[s]) }}
        </label>
      </div>
      <label class="opt-item mt-3">
        <input type="checkbox" v-model="projectState.options.extractAgent" />
        {{ t("Agent 模式（多步自主扫描 + 工具调用，超长小说更稳）") }}
      </label>
      <p class="hint mt-3">
        {{ t("未勾选的阶段会复用已有结果（卡片/剧本/素材），不会重新计费；若某阶段从未运行过则会提示需先运行。") }}
      </p>
      <div class="row mt-3">
        <button class="btn" :disabled="busy || !!assetBusy" @click="start">
          <span v-if="busy" class="spinner" />
          {{ busy ? t("生成中…") : t("开始生成（整书）") }}
        </button>
        <span class="hint">{{ t("只跑上方勾选的阶段与章节") }}</span>
      </div>
    </div>

    <div class="card" v-if="projectState.novel && runMode === 'full'">
      <div class="card-head">
        <h3>{{ t("本次重跑 / 分章节生成章节") }}</h3>
        <div class="card-actions">
          <button class="btn ghost small" @click="toggleAllRerun(true)">{{ t("全选") }}</button>
          <button class="btn ghost small" @click="toggleAllRerun(false)">{{ t("全不选") }}</button>
        </div>
      </div>
      <p class="hint mb-3">{{ t("未勾选章节复用已有缓存；只勾选部分章节时，配音阶段仅生成这些章节的台词（适合分章节批量配音，避免一次性撞限流）。无缓存则跳过") }}</p>
      <div class="opt-grid">
        <label v-for="(ch, i) in projectState.novel.chapters" :key="i" class="opt-item">
          <input
            type="checkbox"
            :checked="rerunChapters === null || rerunChapters.includes(ch.index)"
            @change="(e: any) => toggleChapterRerun(ch.index, (e.target as HTMLInputElement).checked)"
          />
          <span class="text-ellipsis">{{ ch.title }}</span>
        </label>
      </div>
    </div>

    <div class="card" v-if="projectState.lastResult && runMode === 'stage'">
      <div class="card-head">
        <h3>{{ t("分阶段状态（点击「重新生成」单独重跑；已完成阶段复用缓存不计费）") }}</h3>
        <div class="card-actions">
          <span v-if="!busy" class="hint">{{ t("失败阶段重试将只补失败项") }}</span>
        </div>
      </div>
      <StageStatusBoard
        :statuses="stageStatus.stageStatus.value"
        :failed-counts="failedCounts"
        :feedback="stageFeedback"
        :busy="busy"
        @regen="runStageRegen"
      />
      <p class="hint mt-3">
        {{ t("单条立绘 / 单句配音的重生成请在下方「素材」页操作。") }}<br />
        {{ t("「重新生成」只跑该阶段本身，不联动下游：上游改动后下游会标记过期，需手动依次重跑下游，最后点「组装」刷新预览（组装免费）。需一次跑通多阶段请用上方「本次执行阶段」勾选后点开始。") }}
      </p>
    </div>

    <div class="card" v-if="projectState.novel && runMode === 'chapter'">
      <div class="card-head">
        <h3>{{ t("单章节生成（先分章 → 逐章出内容，不含配音）") }}</h3>
        <div class="card-actions">
          <span class="tag" :class="splitMeta.method === 'ai' && !splitMeta.stale ? 'ok' : 'warn'" :title="t('分章来源：AI 分章为语义切分；规则/导入切分是按标题机械切块')">{{ splitMetaText }}</span>
          <span v-if="splitConfirmed" class="tag ok">{{ t("分章已确认") }}</span>
          <button v-if="!queueRunning" class="btn small" :disabled="busy || !!assetBusy" :title="t('逐章补齐剧本＋图像（配音不在内，配音灯请看章节盘配音列，另跑配音阶段）')" @click="runChapterQueue">{{ t("顺序生成未完成") }}</button>
          <button v-else class="btn small" @click="stopChapterQueue">{{ t("停止队列") }}</button>
          <button class="btn ghost small" :disabled="busy || queueRunning || !!assetBusy" :title="t('已生成章节不动，只对新文件分章并生成（纯追加）')" @click="pickAppendFile">{{ t("追加新章节") }}</button>
          <input ref="appendInput" type="file" accept=".txt,text/plain" style="display: none" @change="onAppendFile" />
        </div>
      </div>
      <div class="row mb-3">
        <input type="text" v-model="splitOpinion" :placeholder="t('分章意见（可选）：如“第×章太长请拆分”…')" style="flex: 1" />
        <button class="btn secondary small" :disabled="busy || queueRunning || !!assetBusy" @click="previewSplit">{{ t("AI 分章预览") }}</button>
        <button class="btn small" :disabled="busy || queueRunning || splitConfirmed" @click="confirmSplit">{{ splitConfirmed ? t("已确认") : t("确认分章") }}</button>
      </div>
      <ChapterStatusBoard
        :chapters="enabledNovelChapters"
        :disabled-chapters="disabledNovelChapters"
        :lights="chapterStatus.lights"
        :feedback="scriptChapterFeedback"
        :disabled="busy || queueRunning || !!assetBusy"
        @regen="runChapterFullRegen"
        @toggle="toggleNovelChapter"
      />
      <p class="hint mt-3">
        {{ t("流程：点「AI 分章预览」核对每章边界/标题/字数 → 点「确认分章」→ 点「生成本章」逐章出内容，或点「顺序生成未完成」自动逐章跑完。") }}<br />
        {{ t("单章链＝剧本＋图像＋组装，不含配音（省 TTS 费用）；其他章节自动复用缓存。配音请跑配音阶段或在素材页单句重配。") }}
      </p>
    </div>

    <div v-if="runMode === 'full' && !projectState.novel" class="card">
      <p class="hint">{{ t("还没有小说：请先在「导入小说」页导入小说（或加载示例小说），再选择阶段开始生成。") }}</p>
    </div>
    <div v-if="runMode === 'stage' && !projectState.lastResult" class="card">
      <p class="hint">{{ t("还没有生成结果：请先用「整书生成」跑一次（或切到单章节模式逐章生成），再回来单独重跑某个阶段。") }}</p>
    </div>
    <div v-if="runMode === 'chapter' && !projectState.novel" class="card">
      <p class="hint">{{ t("还没有小说：请先在「导入小说」页导入小说（或加载示例小说），再分章并逐章生成。") }}</p>
    </div>

    <p v-if="error" class="muted mt-3" style="color: var(--err)">{{ error }}</p>

    <div class="tabs">
      <span class="tab-group">{{ t("运行") }}</span>
      <button class="tab" :class="{ active: tab === 'run' }" @click="tab = 'run'">{{ t("状态与费用") }}</button>
      <button class="tab" :class="{ active: tab === 'failed' }" @click="tab = 'failed'">
        {{ t("失败项") }}<template v-if="failedTasks.length">（{{ failedTasks.length }}）</template>
      </button>
      <button class="tab" :class="{ active: tab === 'log' }" @click="tab = 'log'">{{ t("日志") }}</button>
      <span class="tab-group">{{ t("内容") }}</span>
      <button class="tab" :class="{ active: tab === 'asset' }" @click="tab = 'asset'; loadAssetMapNow()">{{ t("素材") }}</button>
      <button class="tab" :class="{ active: tab === 'cards' }" @click="tab = 'cards'">{{ t("卡片编辑") }}</button>
      <button class="tab" :class="{ active: tab === 'script' }" @click="tab = 'script'; loadScripts()">{{ t("剧本") }}</button>
      <button class="tab" :class="{ active: tab === 'bible' }" @click="tab = 'bible'">
        {{ t("视觉圣经") }}
        <span v-if="visualBibleReviewNeeded" class="tab-badge">{{ t("待确认") }}</span>
      </button>
      <button class="tab" :class="{ active: tab === 'video' }" @click="tab = 'video'; checkVideos()">{{ t("视频推荐位") }}</button>
    </div>

    <div v-if="tab === 'run'">
      <div class="stat-grid">
        <div class="stat">
          <span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg></span>
          <div class="stat-body"><div class="label">{{ t("章节") }}</div><div class="value">{{ projectState.novel?.chapters.filter((c) => c.enabled !== false).length ?? 0 }}</div></div>
        </div>
        <div class="stat">
          <span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg></span>
          <div class="stat-body"><div class="label">{{ t("总字数") }}</div><div class="value">{{ (projectState.novel?.fullText.length ?? 0).toLocaleString() }}</div></div>
        </div>
        <div class="stat">
          <span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5" /></svg></span>
          <div class="stat-body"><div class="label">{{ t("素材") }}</div><div class="value">{{ projectState.materials.length }}</div></div>
        </div>
        <div class="stat">
          <span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg></span>
          <div class="stat-body">
            <div class="label">{{ t("状态") }}</div>
            <div class="value" :style="busy ? 'color: var(--warn)' : projectState.lastResult ? 'color: var(--ok)' : ''">{{ busy ? t("运行中") : projectState.lastResult ? t("已完成") : t("未开始") }}</div>
          </div>
        </div>
      </div>
      <div class="card mt-4 mb-0" v-if="liveProgress && busy">
        <div class="card-head">
          <h3>{{ t("实时进度") }}</h3>
          <span style="color: var(--text-faint); font-size: 12px">{{ liveProgress.done }}/{{ liveProgress.total }} · {{ livePct }}%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" :style="{ width: livePct + '%' }"></div></div>
        <p style="color: var(--text-dim); font-size: 12px; margin-top: var(--space-2)">
          {{ liveProgress.step }} · {{ t("当前：") }}{{ liveProgress.label }}
        </p>
      </div>
      <div class="card mt-4 mb-0" v-if="costText">
        <div class="card-head"><h3>{{ t("用量统计") }}</h3></div>
        <div class="stat-grid">
          <div class="stat"><span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg></span><div class="stat-body"><div class="label">LLM</div><div class="value" style="font-size: 15px">{{ costText.llm }}</div></div></div>
          <div class="stat"><span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg></span><div class="stat-body"><div class="label">{{ t("图像") }}</div><div class="value" style="font-size: 15px">{{ costText.image }}</div></div></div>
          <div class="stat"><span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6V18M8 9V15M16 9V15M5 11V13M19 11V13" /></svg></span><div class="stat-body"><div class="label">{{ t("配音") }}</div><div class="value" style="font-size: 15px">{{ costText.tts }}</div></div></div>
        </div>
      </div>
    </div>

    <div v-else-if="tab === 'cards'">
      <EditCards v-if="projectState.lastResult" :cards="projectState.lastResult.cards" @saved="onCardsSaved" />
      <div v-else class="empty">
        <img src="/src/assets/empty-generate.png" alt="" style="width: 240px; opacity: 0.9; margin-bottom: 12px" />
        <p>{{ t("尚无生成结果，先运行一次生成") }}</p>
      </div>
    </div>

    <div v-else-if="tab === 'bible'">
      <VisualBiblePanel @approve="resumeAfterVisualApproval" @changed="onVisualBibleChanged" @prepare="prepareVisualBible" />
    </div>

    <div v-else-if="tab === 'asset'">
      <div v-if="!projectState.lastResult || !assetMap" class="empty">
        <img src="/src/assets/empty-generate.png" alt="" style="width: 220px; opacity: 0.9; margin-bottom: 12px" />
        <p>{{ t("暂无素材（生成后出现）。生成后可在本页对单张立绘、背景、CG、物品图或单句配音单独重新生成。") }}</p>
      </div>
      <template v-else>
        <div v-if="assetBusy" class="asset-regen-status">
          <span style="font-size: 12px; font-weight: 600; flex-shrink: 0">{{ assetBusy }}</span>
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: regenPct + '%' }"></div>
          </div>
          <span class="asset-regen-label">
            <template v-if="regenProgress">{{ regenProgress.done }}/{{ regenProgress.total }} · {{ regenProgress.label }}</template>
            <template v-else>{{ t("准备中…") }}</template>
          </span>
          <button class="btn danger small" @click="regenAbort = true">{{ t("中断") }}</button>
        </div>
        <div class="asset-toolbar">
          <div class="asset-subtabs">
            <button class="asset-subtab" :class="{ active: assetTab === 'figure' }" @click="assetTab = 'figure'">{{ t("角色立绘") }}</button>
            <button class="asset-subtab" :class="{ active: assetTab === 'item' }" @click="assetTab = 'item'">{{ t("物品图") }}</button>
            <button class="asset-subtab" :class="{ active: assetTab === 'bg' }" @click="assetTab = 'bg'">{{ t("背景图") }}</button>
            <button class="asset-subtab" :class="{ active: assetTab === 'cg' }" @click="assetTab = 'cg'">CG</button>
            <button class="asset-subtab" :class="{ active: assetTab === 'voice' }" @click="assetTab = 'voice'">{{ t("配音") }}</button>
          </div>
          <div v-if="assetTab !== 'voice'" class="asset-toolbar-right">
            <span v-if="selectedCount" class="tag ok">{{ t("已选") }} {{ selectedCount }}</span>
            <button class="btn ghost small" @click="selectAllInTab">{{ t("全选本区") }}</button>
            <button class="btn ghost small" :disabled="!selectedCount" @click="clearSelected">{{ t("清空") }}</button>
            <button class="btn small" :disabled="!selectedCount || !!assetBusy" @click="regenSelected">{{ t("重新生成已选（") }}{{ selectedCount }}{{ t("）") }}</button>
            <button class="btn primary small" :disabled="!!assetBusy" @click="regenMissingImages">{{ t("补全缺失图片") }}</button>
            <button class="btn ghost small" :disabled="!!assetBusy" :title="t('剪掉过期映射、迁移旧版CG、删除孤儿文件；缺失项下次运行自动补生成')" @click="cleanupInvalidAssets">{{ t("清理无效素材") }}</button>
          </div>
        </div>

        <div class="card mt-4 mb-0">
          <template v-if="assetTab === 'figure'">
            <div class="card-head">
              <h3>{{ t("角色立绘（三视图 → 立绘/表情/动作）") }}</h3>
            </div>
            <label class="field">
              <span>{{ t("对本区立绘的意见（可选）：") }}</span>
              <input type="text" v-model="assetFeedback.figure" :placeholder="t('如：让「林澈」眼神更锐利、制服更有质感')" />
            </label>
            <div v-for="row in figureRows" :key="row.id" class="asset-row">
              <div class="asset-row-head">
                <span class="asset-name">{{ row.name }}</span>
                <span style="color: var(--text-faint); font-size: 11px">{{ row.id }}</span>
                <span v-if="row.hasRef" class="tag ok" :title="t('已在「卡片编辑」中为该角色设置参考图，三视图/动作将基于参考图生成')">{{ t("有参考图") }}</span>
                <span class="asset-file">{{ fileExistsLabel(row.threeView) }}</span>
                <button class="btn small" :disabled="!!assetBusy" @click="regenThreeView(row.id)">{{ t("重新生成三视图（联动全部）") }}</button>
                <button class="btn secondary small" :disabled="!!assetBusy" @click="regenAllFigure(row.id)">{{ t("重新生成全部表情") }}</button>
              </div>
              <div class="asset-thumb-row">
                <div v-if="row.threeView" class="asset-thumb" :title="t('三视图（点击放大；有参考图时将基于参考图生成）')" @click="openPreview(row.threeView, `${row.name} · 三视图`)">
                  <label class="asset-sel" @click.stop><input type="checkbox" :checked="selected.has(`threeview:${row.id}`)" @change="toggleSelect(`threeview:${row.id}`)" /></label>
                  <LazyThumb :path="row.threeView" :alt="t('三视图')" />
                  <span class="thumb-label">{{ t("三视图") }}</span>
                  <button class="btn ghost small" :disabled="!!assetBusy" @click.stop="reCutout('figure', `${row.id}_threeview`, row.threeView)">{{ t("抠图") }}</button>
                </div>
                <div v-for="e in row.emotions" :key="e.emo" class="asset-thumb" :class="{ missing: !e.file }" :title="`${EMOTION_LABELS[e.emo]}（点击放大）`" @click="e.file && openPreview(e.file, `${row.name} · ${EMOTION_LABELS[e.emo]}`)">
                  <label class="asset-sel" @click.stop><input type="checkbox" :checked="selected.has(`figure:${row.id}:${e.emo}`)" @change="toggleSelect(`figure:${row.id}:${e.emo}`)" /></label>
                  <LazyThumb v-if="e.file" :path="e.file" :alt="EMOTION_LABELS[e.emo]" />
                  <span class="thumb-label">{{ EMOTION_LABELS[e.emo] }}</span>
                  <button class="btn ghost small" :disabled="!!assetBusy" @click.stop="regenFigureEmotion(row.id, e.emo)">{{ t("重生成") }}</button>
                  <button v-if="e.file" class="btn ghost small" :disabled="!!assetBusy" @click.stop="reCutout('figure', e.emo === 'normal' ? row.id : `${row.id}_${e.emo}`, e.file)">{{ t("抠图") }}</button>
                </div>
              </div>
              <div v-if="row.actions.length" style="border-top: 1px dashed var(--border); margin-top: 8px; padding-top: 8px">
                <div class="asset-thumb-row">
                  <div v-for="a in row.actions" :key="a.id" class="asset-thumb" :class="{ missing: !a.file }" :title="`${a.name}（点击放大）`" @click="a.file && openPreview(a.file, `${row.name} · ${a.name}`)">
                    <label class="asset-sel" @click.stop><input type="checkbox" :checked="selected.has(`action:${row.id}:${a.id}`)" @change="toggleSelect(`action:${row.id}:${a.id}`)" /></label>
                    <LazyThumb v-if="a.file" :path="a.file" :alt="a.name" />
                    <span class="thumb-label">{{ a.name }}</span>
                    <button class="btn ghost small" :disabled="!!assetBusy" @click.stop="regenAction(row.id, a.id, a.name)">{{ t("重生成") }}</button>
                    <button v-if="a.file" class="btn ghost small" :disabled="!!assetBusy" @click.stop="reCutout('figure', `${row.id}_act_${a.id}`, a.file)">{{ t("抠图") }}</button>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <template v-else-if="assetTab === 'item'">
            <div class="card-head"><h3>{{ t("物品图") }}</h3></div>
            <label class="field">
              <span>{{ t("对本区物品图的意见（可选）：") }}</span>
              <input type="text" v-model="assetFeedback.item" :placeholder="t('如：物品要更有质感、更有光泽')" />
            </label>
            <div v-for="row in itemRows" :key="row.id" class="asset-row">
              <div class="asset-row-head">
                <span class="asset-name">{{ row.name }}</span>
                <span style="color: var(--text-faint); font-size: 11px">{{ row.id }}</span>
                <span class="asset-file">{{ fileExistsLabel(row.file) }}</span>
                <button class="btn small" :disabled="!!assetBusy" @click="regenItem(row.id)">{{ t("重新生成") }}</button>
              </div>
              <div class="asset-thumb-row">
                <div class="asset-thumb" :title="t('点击放大')" @click="row.file && openPreview(row.file, `${row.name} · 物品图`)">
                  <LazyThumb v-if="row.file" :path="row.file" :alt="row.name" />
                  <span class="thumb-label">{{ t("物品图") }}</span>
                  <button v-if="row.file" class="btn ghost small" :disabled="!!assetBusy" @click.stop="reCutout('item', row.id, row.file)">{{ t("抠图") }}</button>
                </div>
              </div>
            </div>
          </template>

          <template v-else-if="assetTab === 'bg'">
            <div class="card-head"><h3>{{ t("背景图") }}</h3></div>
            <label class="field">
              <span>{{ t("对本区背景图的意见（可选）：") }}</span>
              <input type="text" v-model="assetFeedback.bg" :placeholder="t('如：画面更通透、更有纵深感')" />
            </label>
            <div v-for="row in bgRows" :key="row.sceneId" class="asset-row">
              <div class="asset-row-head">
                <span class="tag">{{ row.chapter }}</span>
                <span class="asset-name">{{ row.location }}</span>
                <span style="color: var(--text-faint); font-size: 11px">{{ row.sceneId }}</span>
                <span class="asset-file">{{ fileExistsLabel(row.file) }}</span>
                <button class="btn small" :disabled="!!assetBusy" @click="regenBg(row.sceneId)">{{ t("重新生成") }}</button>
              </div>
              <div class="asset-thumb-row">
                <div class="asset-thumb" :title="t('点击放大')" @click="row.file && openPreview(row.file, `背景 · ${row.location}`)">
                  <LazyThumb v-if="row.file" :path="row.file" :alt="row.location" />
                  <span class="thumb-label">{{ t("背景图") }}</span>
                </div>
              </div>
            </div>
          </template>

          <template v-else-if="assetTab === 'cg'">
            <div class="card-head"><h3>CG</h3></div>
            <label class="field">
              <span>{{ t("对本区 CG 的意见（可选）：") }}</span>
              <input type="text" v-model="assetFeedback.cg" :placeholder="t('如：构图更有冲击力、光影更戏剧化')" />
            </label>
            <div v-for="row in cgRows" :key="row.sceneId" class="asset-row">
              <div class="asset-row-head">
                <span class="tag">{{ row.chapter }}</span>
                <span class="asset-name">{{ row.title }}</span>
                <span style="color: var(--text-faint); font-size: 11px">{{ row.sceneId }}</span>
                <span class="asset-file">{{ fileExistsLabel(row.file) }}</span>
                <button class="btn small" :disabled="!!assetBusy" @click="regenCgRow(row.chapter, row.sceneId)">{{ t("重新生成") }}</button>
              </div>
              <div class="asset-thumb-row">
                <div class="asset-thumb" :title="t('点击放大')" @click="row.file && openPreview(row.file, `CG · ${row.title}`)">
                  <LazyThumb v-if="row.file" :path="row.file" :alt="row.title" />
                  <span class="thumb-label">CG</span>
                </div>
              </div>
            </div>
          </template>

          <template v-else>
            <div class="card-head">
              <h3>{{ t("配音") }}</h3>
              <div class="card-actions">
                <button class="btn primary small" :disabled="!!assetBusy || !ttsReady" :title="ttsReady ? t('检查全部台词：缺的补配、错配的重配，并清理孤儿文件') : t('配音（TTS）未配置 API')" @click="regenMissingVoices">
                  {{ t("补全缺失/错配语音") }}
                </button>
                <button class="btn ghost small" v-for="c in voiceCharOptions" :key="c.value" @click="regenCharVoice(c.value)" :disabled="!!assetBusy || !ttsReady" :title="ttsReady ? '' : t('配音（TTS）未配置 API')">
                  {{ t("重配「") }}{{ c.label }}{{ t("」全部") }}
                </button>
              </div>
            </div>
            <div v-if="!ttsReady" class="hint" style="margin: 0 0 10px">
              {{ t("重配配音需先在「API 配置」页配置 TTS 服务并填入 API Key；配置后可手动为任意角色/台词重新配音。") }}
            </div>
            <div class="row mb-3">
              <label class="field grow mb-0">
                <span>{{ t("章节筛选") }}</span>
                <select v-model="voiceChapterFilter">
                  <option :value="0">{{ t("全部章节") }}</option>
                  <option v-for="o in voiceChapterOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </label>
              <label class="field grow mb-0">
                <span>{{ t("角色筛选") }}</span>
                <select v-model="voiceCharFilter">
                  <option value="">{{ t("全部角色") }}</option>
                  <option v-for="c in voiceCharOptions" :key="c.value" :value="c.value">{{ c.label }}</option>
                </select>
              </label>
              <label class="opt-item mb-0" :title="t('打开后连同旁白/独白一起列出，否则单看对话会觉得剧情断裂')">
                <input type="checkbox" v-model="showNarrationVoice" />
                {{ t("显示旁白") }}
              </label>
            </div>
            <p v-if="voiceChapterMismatch" class="hint mb-3" style="color: var(--warn)">{{ voiceChapterMismatch }}</p>
            <div v-for="row in voiceRowsShown" :key="row.key" class="asset-row voice">
              <div class="grow">
                <div class="flex items-center gap-2 wrap">
                  <span class="tag">{{ row.chapter }}</span>
                  <span style="font-weight: 600; font-size: 13px">{{ row.displayName }}</span>
                  <span class="faint small">{{ row.scene }}</span>
                  <span class="tag" :class="row.file ? 'ok' : (row.failed ? 'err' : '')">{{ row.file ? t("已生成") : (row.failed ? t("配音失败") : t("未生成")) }}</span>
                </div>
                <div class="hint" style="word-break: break-all">{{ row.text }}</div>
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <button v-if="row.file" class="btn ghost small" @click="playVoice(row.key, row.file)">{{ playingVoiceKey === row.key ? t("⏸ 停止") : t("▶ 试听") }}</button>
                <button class="btn small" :disabled="!!assetBusy || !ttsReady" :title="ttsReady ? '' : t('配音（TTS）未启用或未配置 API')" @click="regenVoice(row.key)">{{ t("重配") }}</button>
              </div>
            </div>
            <div v-if="voiceRows.length > voiceLimit" style="text-align: center; margin-top: 8px">
              <button class="btn secondary small" @click="voiceLimit += 100">{{ t("显示更多（剩余") }} {{ voiceRows.length - voiceLimit }} {{ t("条）") }}</button>
            </div>
            <audio ref="audioRef" style="display: none" @ended="playingVoiceKey = ''"></audio>
            <div v-if="!voiceRows.length" class="empty">{{ t("该筛选下没有对白（或尚未生成配音）") }}</div>
          </template>
        </div>
      </template>
    </div>

    <div v-else-if="tab === 'video'">
      <div class="card" v-if="videoPoints.length">
        <div class="card-head">
          <h3>{{ t("AI 推荐的视频演出位（") }}{{ videoPoints.length }}{{ t(" 个）") }}</h3>
          <div class="card-actions"><button class="btn secondary small" @click="checkVideos">{{ t("刷新状态") }}</button></div>
        </div>
        <p class="hint mb-4">{{ t("提示词粘贴到即梦/可灵生成 mp4，用「导入视频」或手动放入") }} <code>game/video/video_&lt;id&gt;.mp4</code> {{ t("，刷新后自动启用，零 API 费用。") }}</p>
        <div v-for="vp in videoPoints" :key="vp.id" style="border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; margin-bottom: 10px">
          <div class="row" style="justify-content: space-between">
            <span>
              <span class="tag" :class="vp.enabled ? 'ok' : ''">{{ vp.enabled ? t("已启用") : t("未生成") }}</span>
              <span style="font-weight: 600">{{ vp.title }}</span>
              <span style="color: var(--text-dim); font-size: 12px; margin-left: 8px">{{ t("第") }} {{ vp.chapter }} {{ t("章") }} · {{ vp.location }} · {{ vp.durationSecs }}s</span>
            </span>
            <div style="display: flex; gap: 8px">
              <button class="btn small" @click="copyText(vp.videoPrompt, '视频提示词')">{{ t("复制提示词") }}</button>
              <button class="btn small" :disabled="busy || !!assetBusy" @click="importVideo(vp)">{{ t("导入视频") }}</button>
            </div>
          </div>
          <p style="color: var(--text-dim); font-size: 12px; margin-top: 6px">{{ vp.description }}</p>
          <p style="font-size: 12px; margin-top: 6px; color: var(--text-dim)">{{ t("文件名：") }}<code>video_{{ sanitizeId(vp.id) }}.mp4</code></p>
        </div>
        <input v-if="!isTauri()" ref="videoInput" type="file" accept="video/*" style="display: none" @change="onVideoImportFile" />
      </div>
      <div v-else class="empty">
        <img src="/src/assets/empty-generate.png" alt="" style="width: 220px; opacity: 0.9; margin-bottom: 12px" />
        <p>{{ t("暂无视频推荐位（重新生成后出现）") }}</p>
      </div>
    </div>

    <div v-else-if="tab === 'script'">
      <div class="card">
        <div class="card-head">
          <h3>{{ t("分章剧本（按意见重写）") }}</h3>
          <div class="card-actions">
            <button class="btn ghost small" @click="scriptChapterFeedback = {}">{{ t("清空意见") }}</button>
          </div>
        </div>
          <p class="hint mb-3">{{ t("选择章节 → 填写意见（可留空 = 直接重新生成）→ 点击「重新生成此章」。其余章节自动复用缓存。") }}</p>
        <div v-for="ch in projectState.novel?.chapters ?? []" :key="ch.index" class="stage-row mb-2">
          <div class="stage-row-label"><b>{{ ch.title }}</b></div>
          <input type="text" v-model="scriptChapterFeedback[ch.index]" :placeholder="t('意见（可选）：这一章节奏太慢，希望更快推进…')" />
          <button class="btn small" :disabled="busy || !!assetBusy" @click="regenChapter(ch.index)">{{ t("重新生成此章") }}</button>
        </div>
      </div>
      <div class="card" v-if="scriptFiles.length">
        <div class="row" style="justify-content: space-between">
          <select v-model="currentScript" style="flex: 1; max-width: 260px">
            <option v-for="f in scriptFiles" :key="f.name" :value="f.name">{{ f.name }}</option>
          </select>
          <button class="btn secondary small" @click="tauri.openInExplorer(projectState.outputDir + '/game/scene')">{{ t("打开剧本文件夹") }}</button>
        </div>
        <pre style="background: #fbf9ff; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; margin-top: 10px; max-height: 420px; overflow: auto; font-size: 12px; line-height: 1.7; white-space: pre-wrap">{{ scriptFiles.find((f) => f.name === currentScript)?.text }}</pre>
      </div>
      <div v-else class="empty">
        <img src="/src/assets/empty-generate.png" alt="" style="width: 220px; opacity: 0.9; margin-bottom: 12px" />
        <p>{{ t("暂无剧本文件（生成后出现）") }}</p>
      </div>
    </div>

    <div v-else-if="tab === 'failed'">
      <div class="card" v-if="failedTasks.length">
        <div class="card-head">
          <h3>{{ t("失败任务（") }}{{ failedTasks.length }}{{ t(" 个）") }}</h3>
          <div class="card-actions"><button class="btn small" @click="retryFailed">{{ t("定位重试") }}</button><button class="btn secondary small" @click="goFullMode">{{ t("去整书生成") }}</button></div>
        </div>
        <div v-if="failedTaskSummary.length > 1" style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px">
          <span v-for="s in failedTaskSummary" :key="s.label" class="tag" style="background: var(--err-soft); color: var(--text)">{{ s.icon }} {{ s.label }} × {{ s.count }}</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px">
          <div v-for="(f, i) in failedTasks" :key="i" style="border: 1px solid var(--err-soft); background: var(--err-soft); border-radius: var(--radius-sm); padding: 10px 12px">
            <div style="display: flex; align-items: center; gap: 8px">
              <span class="tag err">{{ f.kind === "image" ? t("图像") : f.kind === "script" ? t("剧本") : f.kind === "llm" ? "LLM" : t("配音") }}</span>
              <span>{{ ERROR_CLASS_ICON[classifyError({ message: f.message })] }} {{ ERROR_CLASS_LABEL[classifyError({ message: f.message })] }}</span>
              <span style="font-weight: 600; font-size: 13px">{{ f.id }}</span>
              <span style="color: var(--text-faint); font-size: 11px; margin-left: auto">{{ new Date(f.at).toLocaleTimeString() }}</span>
            </div>
            <p style="font-size: 12px; color: var(--text-dim); margin-top: 4px; word-break: break-all">{{ f.message }}</p>
          </div>
        </div>
      </div>
      <div v-else class="empty">{{ t("暂无失败任务") }}</div>
    </div>

    <div v-else>
      <div class="card">
        <div class="card-head">
          <h3>{{ t("运行日志") }}</h3>
          <div class="card-actions">
            <button class="btn secondary small" @click="saveLogs">{{ t("保存日志") }}</button>
            <button class="btn ghost small" @click="copyLogs">{{ t("复制") }}</button>
          </div>
        </div>
        <div class="log-panel" ref="logPanelRef">
          <div v-for="l in visibleLogs" :key="`${l.at}:${l.step}:${l.message}`" class="log-line" :class="l.level">
            <span class="time">{{ new Date(l.at).toLocaleTimeString() }}</span>
            <span class="step-badge">{{ l.step }}</span>
            <span>{{ l.message }}</span>
          </div>
        </div>
      </div>
    </div>
    <p v-if="copiedMsg" style="color: var(--ok); font-size: 12px; margin-top: 6px">{{ copiedMsg }}</p>
  </div>

  <AssetPreview
    v-if="preview"
    :path="preview.path"
    :label="preview.label"
    @close="preview = null"
  />
</template>
