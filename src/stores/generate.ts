import { computed, nextTick, ref, watch } from "vue";
import { t } from "../i18n";
import { open } from "@tauri-apps/plugin-dialog";
import { projectState, pushLog, clearLogs, scheduleSave, restoreProject, flushPendingProjectSave, getStageLastLevels, getLastActiveStage, resetActiveStage } from "../stores/project";
import { readWorkingCards } from "../utils/persist";
import { activeConfig, configState, addRecentOutputDir } from "../stores/config";
import { upsertProject } from "../stores/projects";
import { Pipeline, novelFingerprint, joinAppendText, dedupeSceneIdsAcrossChapters } from "../core/pipeline";
import type { SplitMethod } from "../core/pipeline";
import { resolveTemplateDir } from "../utils/template";
import { tauri, isTauri } from "../utils/tauri";
import { vfsWriteFileBase64 } from "../utils/vfsWeb";
import { sanitizeId } from "../core/render";
import { errMsg } from "../utils/errors";
import { fileToBase64 } from "../utils/file";
import { ERROR_CLASS_ICON, ERROR_CLASS_LABEL, classifyError } from "../utils/errorClassifier";
import { cutoutErrorHint } from "../utils/cutoutErrorHint";
import { log as logger, dumpLogHistory } from "../utils/logger";
import { useStageStatus } from "../composables/useStageStatus";
import { runStatusSync, runStatusSetFailed, registerRunStop } from "./runStatus";
import { useChapterStatus, isChapterContentComplete, emptyChapterLight } from "../composables/useChapterStatus";
import type { AssetMap, FailedTask, ImageTask, PipelineEvent, StageFeedback, StageKey, VideoSuggestion } from "../core/types";
import { STAGE_LABELS, STAGE_ORDER } from "../core/types";
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
  type RegenBatchStats,
} from "../core/regenerate";
import { reCutoutAsset, buildImageTasks, repairImageAssets } from "../core/images";
import { repairVoiceAssets } from "../core/voice";
import { planStageCascade } from "../core/stageCascade";
import { missingImagesInChapters, summarizeImagePlan } from "../core/imageStats";
import { recognizeStyle } from "../core/recognize";
import { configIsUsable } from "../api/providers";
import { useAssetThumbs, ensureAssetLoaded, clearThumbCache } from "../composables/useAssetThumbs";
import {
  imageRunPreparationStages,
  approvalResumePlan,
  resumeStagesAfterVisualApproval,
  visualBibleNeedsReview,
  chapterScopeText,
} from "../core/visualBibleWorkflow";
import {
  computeProjectVisualBibleFingerprint,
  refreshVisualBibleFingerprint,
  syncBibleCharactersWithCards,
} from "../core/visualBible";
import { emptyAssetMap, parseAssetMap, updateAssetMap, listAssetBackups, restoreAssetBackup } from "../core/assetMap";
import { parseChapterScript } from "../core/dataValidation";
import { scriptCacheFileName, scriptCacheRest, scriptFingerprint, titleHash, cardsFingerprint } from "../core/cache";
import { mergeFailedTasks, mutateFailedTasks, readFailedTasks, visibleFailedTasks } from "../core/failedTasks";
import {
  applySpeakerFix,
  deleteScriptLine,
  readScriptVerify,
  scriptVerifyFileName,
  verifyIssueKey,
  verifyScriptAgainstSource,
  writeScriptVerify,
} from "../core/script";
import type { SpeakerIssue } from "../core/script";
import type { ChapterScript } from "../core/types";

/**
 * 生成页的全部状态与行为（原 GeneratePage.vue 的 <script setup> 主体）。
 * 页面组件只负责编排与模板映射；逻辑集中在此，便于复用、测试与瘦身。
 * 注意：模板 ref（appendInput / styleRefInput / logPanelRef / videoInput）也在此创建，
 * 页面通过解构绑定，模板 ref="xxx" 仍然生效。
 */

/**
 * 生成页运行态的单一来源（原 GeneratePage.vue 的 <script setup> 主体）。
 *
 * 与 stores/project.ts 一样是模块级单例：
 * - 页面与各区块组件共享同一份运行态，无需 props 透传；
 * - 运行中途切换到别的页面再回来，状态与进行中的队列不会丢。
 */

const tab = ref<"run" | "products" | "settings" | "log">("run");

/* ---- 生成范围（互斥）：逐章生成 / 整书生成 / 单阶段重跑 ---- */
type RunMode = "full" | "stage" | "chapter";
const RUN_MODE_KEY = "novelforge:runMode";
function initialRunMode(): RunMode {
  // 有小说就直接进「逐章生成」：它是最常用、最灵活的主线，不必先切模式。
  if (projectState.novel) return "chapter";
  try {
    const s = localStorage.getItem(RUN_MODE_KEY);
    if (s === "full" || s === "stage" || s === "chapter") return s;
  } catch {
    /* 忽略 */
  }
  return "full";
}
const runMode = ref<RunMode>(initialRunMode());
watch(runMode, (m) => {
  try {
    localStorage.setItem(RUN_MODE_KEY, m);
  } catch {
    /* 忽略 */
  }
});

// 载入小说后自动落到「逐章生成」（仅发生在「从无小说变为有小说」时）
watch(
  () => projectState.novel,
  (novel, prev) => {
    if (novel && !prev) runMode.value = "chapter";
  },
);
const runModeHint = computed(() => {
  switch (runMode.value) {
    case "full":
      return t("整书生成：按勾选的阶段＋章节一次跑全流程，适合第一次生成");
    case "stage":
      return t("单阶段：只重跑某一个阶段，其余复用已有结果");
    default:
      return t("逐章生成：单章 / 多选批量 / 顺序补全，可选是否包含配音");
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
/**
 * 待续跑计划的作用域（章节范围）。视觉守门挡下的是「某一次具体运行」，
 * 批准后必须按同范围续跑——否则单章/选中章会被放大成全书，白烧一遍图像费用。
 */
const pendingResumeScope = ref<ResumeScope | null>(null);

/** 待续跑计划的作用域：章节范围 + 分部分强制章节 + 全量/意见（与 ExecuteOptions 同名同义）。
 * 必须原样保存：只存章节范围会丢掉用户点选的「全量」或填写的意见，
 * 批准后静默变成「只补缺失」，用户以为跑的是全量。 */
interface ResumeScope {
  rerunChapters?: number[] | null;
  forceImageChapters?: number[];
  forceVoiceChapters?: number[];
  forceStages?: StageKey[];
  feedback?: StageFeedback;
}

/** 记录待续跑计划（阶段 + 作用域）。批准后由 resumeAfterVisualApproval 消费并清空。 */
function setPendingResume(stages: StageKey[], scope: ResumeScope | null = null): void {
  pendingResumeStages.value = stages;
  pendingResumeScope.value = scope
    ? {
        rerunChapters: scope.rerunChapters,
        forceImageChapters: scope.forceImageChapters,
        forceVoiceChapters: scope.forceVoiceChapters,
        forceStages: scope.forceStages,
        feedback: scope.feedback,
      }
    : null;
}

/** 计划只能消费一次：跑过/取消过都必须清掉，避免二次「批准」把同一批阶段重放一遍。 */
function clearPendingResume(): void {
  pendingResumeStages.value = [];
  pendingResumeScope.value = null;
}
const pipelineRef = ref<Pipeline | null>(null);
/** 中止/异常路径从 Pipeline 收回的失败任务（未完成 run 的失败项也可见） */
const lastRunFailedTasks = ref<FailedTask[]>([]);
/**
 * 磁盘上的失败项（failed.json）——失败列表的唯一事实来源：
 * 管线/素材重试都会读写 failed.json；旧实现只看 projectState.lastResult.failedTasks（快照，永不刷新），
 * 导致「点重试成功后报错仍挂在页面上」（用户实测）。现在统一从 failed.json 读取并随运行/重试刷新。
 */
const persistedFailedTasks = ref<FailedTask[]>([]);

export async function refreshFailedTasks(): Promise<void> {
  const dir = projectState.outputDir;
  persistedFailedTasks.value = dir ? await readFailedTasks(dir) : [];
  // 同步快照（项目状态持久化不再保留过期失败项）
  if (projectState.lastResult) projectState.lastResult.failedTasks = failedTasks.value.slice();
}
const scriptFiles = ref<{ name: string; text: string }[]>([]);
const currentScript = ref("");
const videoStatus = ref<Record<string, boolean>>({});
const videoInput = ref<HTMLInputElement | null>(null);
const videoImportTarget = ref<{ id: string; title: string } | null>(null);
const copiedMsg = ref("");
/** 提示条级别：保存失败等错误提示不能再用成功色显示 */
const copiedMsgLevel = ref<"ok" | "err">("ok");
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
/** 本次运行包含的阶段下标：步骤指示器据此把未跑的阶段标成「跳过」 */
const activeStepIndexes = computed(() =>
  activeRunLabels.value.map((l) => PIPELINE_STEPS.indexOf(l)).filter((i) => i >= 0),
);
/** UI57：清空上一次运行的阶段标记。只在「下一次运行开始时」调用——
 *  单阶段重跑结束不再在 finally 清空，否则结束后「跳过」标记立刻消失，看不出本次跑了哪些阶段。 */
function clearRunLabels(): void {
  activeRunLabels.value = [];
  currentStep.value = -1;
  failedSteps.value = [];
}

watch(
  () => projectState.logs.length,
  async () => {
    // 追加前先记住用户是否在底部：向上翻阅历史日志时不能被新日志强行拽回底部
    const panel = logPanelRef.value;
    const wasAtBottom = !panel || panel.scrollHeight - panel.scrollTop - panel.clientHeight < 40;
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
    if (wasAtBottom && logPanelRef.value) logPanelRef.value.scrollTop = logPanelRef.value.scrollHeight;
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
  // 事实来源：failed.json（persistedFailedTasks）∪ 本次运行内存列表；按「身份」去重
  // （图像 bg/cg 共用 scene.id，只按 id 去重会互相抵消）
  return visibleFailedTasks(persistedFailedTasks.value, lastRunFailedTasks.value);
});
// 换项目/恢复项目后刷新磁盘失败项（启动时 outputDir 从空变为路径也会触发）
watch(
  () => projectState.outputDir,
  () => {
    void refreshFailedTasks();
  },
);
// 同步到轻量模块（App.vue 侧栏失败徽标用；避免外层组件引入整个 store）。
// immediate：启动恢复出的历史失败项也要立即可见（此前 watch 不立即执行，徽标要等下一次变化才出现）
watch(failedTasks, (list) => runStatusSetFailed(list.length), { immediate: true });

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
/** 分阶段全量开关：勾选后该阶段无视缓存全量重跑（不需要填意见，执行前二次确认，一次有效） */
const stageForce = ref<Partial<Record<StageKey, boolean>>>({});
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
  getLlmAvailable: () => !!activeConfig("llm")?.apiKey,
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
  getImageAvailable: () => !!activeConfig("image")?.apiKey,
});

const enabledNovelChapters = computed(() => projectState.novel?.chapters.filter((c) => c.enabled !== false) ?? []);
const disabledNovelChapters = computed(() => projectState.novel?.chapters.filter((c) => c.enabled === false) ?? []);

/**
 * 图片计划统计（生成前先算总账）：按章节灯聚合「共多少张 / 已生成 / 待生成」。
 * 只统计已有剧本的章节（没有剧本算不出本章要用哪些图）；未生成剧本的章节单独计数如实说明。
 */
const imagePlanSummary = computed(() =>
  summarizeImagePlan(
    chapterStatus.lights,
    enabledNovelChapters.value.map((c) => c.index),
  ),
);

/** 生成前的图片总账文案：图像关闭 / 未配置 API / 尚无剧本都给出明确说法，不让用户猜 */
const imagePlanText = computed(() => {
  if (!projectState.options.useImage) return t("图像已关闭（可在「生成内容」开启）");
  if (!activeConfig("image")?.apiKey) return t("未配置图像 API，图片不会生成");
  const s = imagePlanSummary.value;
  if (!s.knownChapters) return t("剧本生成后自动计算图片总数");
  const base = t("图片共 {total} 张：已生成 {done} · 待生成 {missing}", { total: s.total, done: s.done, missing: s.missing });
  return s.unknownChapters ? `${base}${t("（另有 {n} 章未生成剧本，未计入）", { n: s.unknownChapters })}` : base;
});

/** 指定章节范围内待生成的图片张数（按章节灯聚合；缺剧本的章节不计入） */
function missingImagesForChapters(indices: number[]): number {
  return missingImagesInChapters(chapterStatus.lights, indices);
}

/** 批量运行确认里的图片开销提示（图像关闭/未配置/未知时不显示） */
function imageBatchNote(indices: number[]): string {
  if (!projectState.options.useImage || !activeConfig("image")?.apiKey) return "";
  const missing = missingImagesForChapters(indices);
  return missing > 0 ? t("；图像待生成约 {n} 张", { n: missing }) : "";
}

/** 停用/启用章节（持久化；停用后管线跳过该章，编号会前移，配音 key 随之变化） */
function toggleNovelChapter(novelIdx: number): void {
  const ch = projectState.novel?.chapters.find((c) => c.index === novelIdx);
  if (!ch) return;
  const disabling = ch.enabled !== false;
  const laterEnabled = projectState.novel?.chapters.filter((c) => c.index > novelIdx && c.enabled !== false).length ?? 0;
  // 章节编号决定剧本/配音缓存的对齐：启停会让后续章节编号前移/后移，可能造成错位重配。执行前说明影响。
  if (disabling && laterEnabled > 0) {
    if (!window.confirm(`停用第 ${novelIdx + 1} 章「${ch.title}」后，后续 ${laterEnabled} 个启用章节编号前移，已有剧本/配音缓存会按新编号重新对齐（可能触发重配）。继续吗？`)) return;
  } else if (!disabling) {
    if (!window.confirm(`重新启用第 ${novelIdx + 1} 章「${ch.title}」？后续章节编号会依次后移，已有配音缓存可能因此对不上而重配。继续吗？`)) return;
  }
  ch.enabled = !disabling;
  // 停用章不能留在批量选择里：否则「已选 N」与「生成选中」的实际范围对不上
  if (ch.enabled === false) selectedChapters.value = selectedChapters.value.filter((i) => i !== novelIdx);
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

/* 分章确认（按输出目录 + 小说内容 + 分章选项持久化：任一变化后旧确认自动失效） */
const splitOpinion = ref("");
const splitConfirmed = ref(false);
/** 逐章工作台的多选（novel index）。声明在 outputDir watch 之前：immediate 回调会清空它 */
const selectedChapters = ref<number[]>([]);
function splitConfirmKey(): string {
  return `novelforge:splitConfirmed:${projectState.outputDir}`;
}
/** 确认签名：小说正文指纹 + 碎章阈值 + 是否保留特殊章节。只认「同一份输入」的核对结果 */
function splitConfirmSignature(): string {
  const novel = projectState.novel;
  if (!novel) return "";
  return JSON.stringify({
    fp: novelFingerprint(novel.fullText ?? ""),
    min: projectState.options.splitMinChapterChars ?? 0,
    keep: projectState.options.splitKeepSpecials ?? false,
  });
}
function loadSplitConfirmed(): void {
  try {
    const raw = localStorage.getItem(splitConfirmKey());
    // 兼容旧值 "1"：无法判断输入是否变化，保守视为已确认（首次改动后会被新签名覆盖）
    if (raw === "1") { splitConfirmed.value = true; return; }
    splitConfirmed.value = !!raw && raw === splitConfirmSignature();
  } catch {
    splitConfirmed.value = false;
  }
}
watch(() => projectState.outputDir, () => {
  loadSplitConfirmed();
  // 换项目立即清空逐章选择：旧索引在新项目里指向别的章
  selectedChapters.value = [];
  void chapterStatus.refresh();
  void loadSplitMeta();
  // 卡片以磁盘 cards.json 为准：重启/切换项目后立刻补齐结构。
  // 否则 project_state.json 里的旧卡片快照会与图像阶段实际用的卡片不一致，
  // 视觉守门批准时算出的指纹和图像阶段复算的指纹对不上，图像会被判「输入已变化」而跳过。
  if (projectState.outputDir && !projectState.lastResult?.cards?.characters?.length) {
    void ensureLiveResultShape(projectState.outputDir);
  }
}, { immediate: true });
watch(() => projectState.novel, () => {
  // 章节集合变化（重分章/换小说/追加）后，选择里指向不存在章节的索引要清掉
  const valid = new Set(enabledNovelChapters.value.map((c) => c.index));
  if (selectedChapters.value.some((i) => !valid.has(i))) {
    selectedChapters.value = selectedChapters.value.filter((i) => valid.has(i));
  }
  void chapterStatus.refresh();
  void loadSplitConfirmed();
  void loadSplitMeta();
});
// 分章选项变化 = 分章结果会变，「已核对」不再成立
watch(
  () => [projectState.options.splitMinChapterChars, projectState.options.splitKeepSpecials],
  () => loadSplitConfirmed(),
);

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
  // 带意见 = 强制全书 AI 重新分章 + 提取：计费且下游缓存作废，执行前显式确认
  if (fb && !window.confirm("填写了分章意见：本次将强制全书 AI 重新分章（并自动带上提取，有 LLM 时计费）；重分章会使下游剧本/图像/配音缓存按指纹作废重跑。继续吗？")) return;
  pushLog({
    step: "分章",
    message: `AI 分章预览开始（${fb ? "带意见：强制重切" : upgrade ? "规则回退升级：强制 AI 重切（下游缓存作废）" : "无意见：复用缓存"}）`,
    level: "info",
    at: Date.now(),
  });
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
    localStorage.setItem(splitConfirmKey(), splitConfirmSignature());
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

/* ---- 逐章工作台：多选 + 含配音（单章链的灵活入口） ---- */
const chapterIncludeVoice = ref(false);
const chapterHasCards = computed(() => (projectState.lastResult?.cards?.characters?.length ?? 0) > 0);

function toggleChapterSelected(idx: number, checked: boolean): void {
  const set = new Set(selectedChapters.value);
  if (checked) set.add(idx);
  else set.delete(idx);
  selectedChapters.value = [...set].sort((a, b) => a - b);
}

function selectIncompleteChapters(): void {
  selectedChapters.value = enabledNovelChapters.value
    .filter((c) => !isChapterContentComplete(chapterStatus.lights[c.index] ?? emptyChapterLight()))
    .map((c) => c.index);
}

function clearChapterSelection(): void {
  selectedChapters.value = [];
}

/** 生成选中的章节（多选批量） */
async function runSelectedChapters(): Promise<void> {
  if (busy.value || queueRunning.value) return;
  if (!selectedChapters.value.length) return;
  await runChapterBatch([...selectedChapters.value]);
}

/** 就地补齐前置：没有卡片时先跑 分章＋提取，再让用户继续逐章生成 */
async function prepareChapterCards(): Promise<void> {
  // 计费操作前置确认：有 LLM 时按全书调用（分章＋提取），且分章会按指纹作废下游缓存
  if (!window.confirm("将执行「分章＋卡片提取」：有 LLM 时按全书调用（计费），分章结果变化会使下游剧本/图像/配音缓存按指纹作废。继续吗？")) return;
  lastRunFailedTasks.value = [];
  await execute({ stages: ["split", "extract"], clearLogsFirst: false });
}

/** 队列令牌：停止后马上再开新队列时，旧队列的 finally 不得把新队列的 queueRunning 清掉 */
let queueToken = 0;

/**
 * 抢占队列（同步，必须在任何 await 之前调用）：
 * 「顺序补全 / 生成选中」的入口此前先 await 状态刷新再置 queueRunning，
 * 这期间用户再点一次会二次进入、两个循环互相把对方停掉。
 */
function claimQueue(): number | null {
  // B37：抢占失败必须明确反馈——调用方此前只静默 return，用户点完确认后毫无反应。
  if (busy.value) {
    error.value = "队列未启动：已有生成任务正在运行，请等它完成或先点「停止」再试";
    pushLog({ step: "单章", message: error.value, level: "warn", at: Date.now() });
    return null;
  }
  if (queueRunning.value) {
    error.value = "队列未启动：已有一条逐章队列正在运行（如需重开请先点「停止队列」）";
    pushLog({ step: "单章", message: error.value, level: "warn", at: Date.now() });
    return null;
  }
  if (assetBusy.value) {
    error.value = `队列未启动：素材任务（${assetBusy.value}）正在运行，请等它完成或先点「停止」再试`;
    pushLog({ step: "单章", message: error.value, level: "warn", at: Date.now() });
    return null;
  }
  queueRunning.value = true;
  return ++queueToken;
}

function releaseQueue(token: number): void {
  if (token === queueToken) {
    queueRunning.value = false;
    void chapterStatus.refresh();
  }
}

/** 本次逐章链的说明文案：图像可用性 + 是否含配音，避免日志与实际执行不符 */
function chapterChainText(imagesBlockedByBible: boolean): string {
  const imageNote = !projectState.options.useImage
    ? ""
    : imagesBlockedByBible
      ? "（图片待视觉守门确认，暂不生成）"
      : !activeConfig("image")?.apiKey
        ? "（未配置图像 API，图片暂不生成）"
        : "";
  const parts = projectState.options.useImage && !imageNote ? "剧本＋图像＋组装" : "剧本＋组装";
  return `${parts}${imageNote}${chapterIncludeVoice.value ? "（含配音）" : "（不含配音）"}`;
}

/** 逐章批量：按给定章节号依次跑单章链；前一章落盘后再跑下一章；失败/中止即停 */
async function runChapterBatch(indices: number[]): Promise<void> {
  const novel = projectState.novel;
  if (!novel) {
    error.value = t("请先在「导入小说」页导入小说（或加载示例小说）");
    return;
  }
  // 计费批量操作前置确认：章节数 + 是否含配音 + 图片总账（剧本/图像按缓存只补缺失，但缺失部分会计费）
  const voiceNote = chapterIncludeVoice.value ? "，含配音（TTS 计费）" : "";
  const imageNote = imageBatchNote(indices);
  if (!window.confirm(`将逐章生成 ${indices.length} 个章节${voiceNote}${imageNote}：剧本/图像按缓存只补缺失（已完成的不会重复计费）。继续吗？`)) return;
  const token = claimQueue();
  if (token === null) return;
  try {
    await chapterStatus.refresh();
    await runChapterBatchInner(indices);
  } finally {
    releaseQueue(token);
  }
}

async function runChapterBatchInner(indices: number[]): Promise<void> {
  const novel = projectState.novel!;
  const wanted = new Set(indices);
  const targets = novel.chapters.filter((c) => c.enabled !== false && wanted.has(c.index));
  if (!targets.length) {
    pushLog({ step: "单章", message: "没有可生成的章节（可能都已停用或未选中）", level: "warn", at: Date.now() });
    return;
  }
  // 视觉守门待确认时图像会被逐章跳过：队列照跑（剧本该出还得出），但收尾不能谎报「全部生成完毕」。
  const imagesBlockedByBible = projectState.options.useImage && visualBibleNeedsReview(projectState.visualBible);
  // 累计本批次的失败项（用 id@at 去重，避免把入队前就存在的旧失败算进来）
  const seenFailureKeys = new Set(failedTasks.value.map((f) => `${f.id}@${f.at}`));
  const batchFailures: FailedTask[] = [];
  const collectFailures = (): void => {
    for (const f of failedTasks.value) {
      const key = `${f.id}@${f.at}`;
      if (seenFailureKeys.has(key)) continue;
      seenFailureKeys.add(key);
      batchFailures.push(f);
    }
  };
  let done = 0;
  let stoppedAt = "";
  pushLog({
    step: "单章",
    message: `队列开始：${targets.length} 章待生成（${targets.map((c) => `第${c.index + 1}章「${c.title}」`).join("、")}），逐章跑${chapterChainText(imagesBlockedByBible)}`,
    level: "info",
    at: Date.now(),
  });
  for (const ch of targets) {
    // B27：停止请求（stopping）一并作为退出条件——不再预先置 queueRunning=false，
    // 队列要等当前在途章节真正结束才退出（侧栏「正在停止…」保持可见）。
    if (!queueRunning.value || stopping.value) {
      stoppedAt = ch.title;
      break;
    }
    pushLog({ step: "单章", message: `队列进度 ${done + 1}/${targets.length}：开始第 ${ch.index + 1} 章「${ch.title}」`, level: "info", at: Date.now() });
    // 队列内逐章不组装：中途还有章节没剧本时，组装会被「保护已有游戏不缩水」逻辑拦下，
    // 导致首章一失败整条队列就停死（永远到不了后面的章）。队列结束统一组装一次即可。
    const ok = await runChapterFullRegen(ch.index, { fromQueueBatch: true });
    collectFailures();
    if (!ok) {
      stoppedAt = ch.title;
      break;
    }
    done++;
  }
  // 统一收尾组装（本地免费）：只在整批都成功时执行。
  // 有章节失败/中途停止时不组装——残缺的章节集会覆盖游戏目录、把未完成章节的旧场景删掉；
  // 保留旧预览更安全，补齐后点「组装」刷新即可。
  if (targets.length > 0 && done >= targets.length) {
    // B26：用户已停止时不得再派发收尾组装（停止的语义就是不再派发新任务）；
    // 停止发生在最后一章刚跑完的竞态下 done 可能已等于总数，必须再查一次停止状态。
    if (stopping.value || !queueRunning.value) {
      pushLog({ step: "单章", message: "队列已停止：跳过收尾组装（已完成的章节内容保留），可稍后手动点「组装」刷新预览", level: "warn", at: Date.now() });
    } else {
      const assembled = await execute({ stages: ["assemble"], fromQueue: true, clearLogsFirst: false });
      if (!assembled) {
        pushLog({ step: "单章", message: "队列完成，但重新组装未完成（预览可能未包含最新章节），可稍后手动点「组装」刷新", level: "warn", at: Date.now() });
      }
    }
  } else if (done > 0) {
    pushLog({
      step: "单章",
      message: `队列未全部完成：本次已完成 ${done}/${targets.length} 章，已跳过组装（避免残缺章节覆盖游戏目录）；补齐后可点「组装」刷新预览`,
      level: "warn",
      at: Date.now(),
    });
  }
  if (tab.value === "products") void loadScripts();
  // 收尾时重算一次（不用队列开始时的快照）：队列中途批准了视觉守门时，后面的章节是带着图像跑的，
  // 不能再按旧快照去提示"图片未生成"并记一份假的待补计划
  const imagesBlockedNow = projectState.options.useImage && visualBibleNeedsReview(projectState.visualBible);
  const failureTail = batchFailures.length
    ? `；本次有 ${batchFailures.length} 个失败项（${[...new Set(batchFailures.map((f) => f.step))].join("、")}），可到「失败项」查看并补跑（已完成的不会重复计费）`
    : "";
  if (done >= targets.length) {
    if (imagesBlockedNow) {
      setPendingResume(resumeStagesAfterVisualApproval(["image", "assemble"]), { rerunChapters: targets.map((c) => c.index) });
      pushLog({
        step: "视觉守门",
        message: `队列完成：${done} 章剧本已生成；图片因视觉守门待确认未生成——去「视觉守门」确认并批准后会自动补齐图像并重新组装（页面顶部横幅也有「去确认」入口）`,
        level: "warn",
        at: Date.now(),
      });
    } else if (projectState.options.useImage && !activeConfig("image")?.apiKey) {
      // 未配置图像 API：章节灯按"图像不适用"处理（不然队列永远收敛不了），但必须明说图片没生成
      pushLog({
        step: "单章",
        message: `队列完成：${done} 章剧本已生成；未配置图像生成 API，图片未生成——请先在「API 配置」页配置后再点「图像」阶段补齐`,
        level: "warn",
        at: Date.now(),
      });
    } else if (batchFailures.length) {
      pushLog({ step: "单章", message: `队列完成：${done} 章已处理，但有失败项未补齐${failureTail}`, level: "warn", at: Date.now() });
    } else {
      pushLog({ step: "单章", message: `队列完成：${done} 章内容全部生成完毕`, level: "success", at: Date.now() });
    }
  } else {
    pushLog({
      step: "单章",
      message: `队列停止：已完成 ${done}/${targets.length} 章${stoppedAt ? `，停在「${stoppedAt}」` : ""}（失败或手动中止），可处理后再次点顺序生成继续（已完成的章会自动跳过）${failureTail}`,
      level: "warn",
      at: Date.now(),
    });
  }
}

/** 顺序补全：把所有「未完成」的启用章节排进逐章队列（不再要求先确认分章） */
async function runChapterQueue(): Promise<void> {
  const novel = projectState.novel;
  if (!novel) {
    error.value = t("请先在「导入小说」页导入小说（或加载示例小说）");
    return;
  }
  // 先刷新章节灯再算「未完成」与图片总账，确认框里的张数才是真实值
  await chapterStatus.refresh();
  const pending = novel.chapters
    .filter((c) => c.enabled !== false && !isChapterContentComplete(chapterStatus.lights[c.index] ?? emptyChapterLight()))
    .map((c) => c.index);
  if (!pending.length) {
    pushLog({ step: "单章", message: "全部启用章节的内容（剧本＋图像）均已完成，无需再跑", level: "success", at: Date.now() });
    return;
  }
  // 计费批量操作前置确认（逐章链可能跑图像/配音，只补缺失但缺失部分会计费）
  const imageNote = imageBatchNote(pending);
  if (!window.confirm(`顺序补全：将依次生成 ${pending.length} 个未完成章节${imageNote}（逐章跑，按当前内容设置执行；图像/配音只补缺失但会计费）。继续吗？`)) return;
  const token = claimQueue();
  if (token === null) return;
  try {
    await runChapterBatchInner(pending);
  } finally {
    releaseQueue(token);
  }
}

function stopChapterQueue(): void {
  pipelineRef.value?.abort();
  // 与顶部「停止」同口径：素材重生成信号一起掐掉，并让按钮进入「正在停止…」态
  regenAbort.value = true;
  stopping.value = true;
  // B27：不再预先置 queueRunning=false。queueRunning 由队列循环退出时的 releaseQueue 置位，
  // 「正在停止…」才会保持到真正的在途任务结束（否则 watch 立刻复位，UI 误以为已停完）。
  // 循环退出条件同时检查 stopping（见 runChapterBatchInner）。
  pendingStop = true;
  pushLog({ step: "单章", message: "用户停止队列：当前章节完成后即停，已完成的章节下次自动跳过", level: "warn", at: Date.now() });
  pushLog({
    step: "单章",
    message: "停止 = 不再派发新任务：正在发送中的请求会跑完当前这一张，之后不再发起新的图片/参考图描述请求；已生成的内容一律保留。",
    level: "info",
    at: Date.now(),
  });
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
// 图像/配音相关选项、语言与画风/文风配置变化会改变「完成」口径（任务数、缓存指纹、是否可生成），
// 必须刷新看板与章节灯，否则切换开关后仍显示旧的完成状态/假的缺失数字
watch(
  () => [
    projectState.options.useImage,
    projectState.options.useTts,
    projectState.options.figureEmotions,
    projectState.options.figureDetail,
    projectState.options.characterPoses,
    projectState.options.styleAnchor,
    projectState.options.imageBudgetPerChapter,
    projectState.options.cgPerChapter,
    // B29：语言影响翻译感知的剧本/章节指纹；scriptStyle 决定剧本缓存指纹；imageStyle 影响图像任务口径
    projectState.options.language,
    projectState.options.scriptStyle,
    projectState.options.imageStyle,
    activeConfig("image")?.apiKey,
    activeConfig("tts")?.apiKey,
    activeConfig("llm")?.apiKey,
  ],
  () => {
    void chapterStatus.refresh();
    void stageStatus.refresh();
  },
);
void stageStatus.refresh();

/* ---- 风格参考图：上传图片 → AI 识别画风 → 写入统一画风约束 ---- */
const styleRefSrc = ref("");
const styleRecognizing = ref(false);
const styleRefInput = ref<HTMLInputElement | null>(null);

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

/** 画风识别取消：单次视觉调用无法中途掐断，但可丢弃结果不再应用 */
const styleAbort = ref(false);
function cancelStyleRecognize(): void {
  if (styleRecognizing.value) styleAbort.value = true;
}

async function recognizeStyleAndApply(b64: string): Promise<void> {
  const cfg = activeConfig("vision");
  if (!configIsUsable(cfg, "vision")) {
    pushLog({ step: "画风", message: t("图片识别 API 未配置或不可用，无法识别画风；请先在「API 配置」页配置"), level: "warn", at: Date.now() });
    return;
  }
  styleRecognizing.value = true;
  styleAbort.value = false;
  try {
    const style = await recognizeStyle(cfg, b64);
    if (styleAbort.value) {
      pushLog({ step: "画风", message: "已取消画风识别：结果未应用（参考图仍保留，可重新识别）", level: "warn", at: Date.now() });
      return;
    }
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

/** 单阶段重跑成功后是否自动补齐下游缺失资产（图像/配音/组装）；旧项目缺该字段按「开启」处理 */
const autoCascadeDownstream = computed(() => projectState.options.autoCascadeDownstream !== false);

/** 会触发下游自动补齐的阶段：只有资产链上的阶段。
 * 分章/翻译/提取属于文本上游——重跑后剧本本身就得再跑一遍，此刻自动补图只会拿到与剧本对不上的旧内容，
 * 所以仍保持旧的严格单阶段行为（提示用户手动依次重跑）。 */
const CASCADE_TRIGGERS = new Set<StageKey>(["script", "image", "voice"]);

/* ==================== 剧本 Tab 单章重生成 ==================== */

const scriptChapterFeedback = ref<Record<number, string>>({});
/** 单章全量开关：勾选后该章跳过剧本缓存直接重写（同范围图像同步强制），一次有效 */
const chapterForce = ref<Record<number, boolean>>({});

/* ==================== 素材 Tab ==================== */

const assetMap = ref<AssetMap | null>(null);
const assetTab = ref<"figure" | "item" | "bg" | "cg" | "voice">("figure");
const assetBusy = ref("");
const assetFeedback = ref<Record<string, string>>({ figure: "", item: "", bg: "", cg: "" });

/** 批量重生成的意见归属：选择键 → 意见框分区（threeview/action 归入 figure，与选择语义一致） */
function feedbackAreasForKeys(keys: string[]): Array<"figure" | "item" | "bg" | "cg"> {
  const areas = new Set<"figure" | "item" | "bg" | "cg">();
  for (const key of keys) {
    const kind = key.split(":")[0];
    if (kind === "threeview" || kind === "figure" || kind === "action") areas.add("figure");
    else if (kind === "item") areas.add("item");
    else if (kind === "bg") areas.add("bg");
    else if (kind === "cg") areas.add("cg");
  }
  return [...areas];
}

/** 读取这些分区的意见（不立刻清空）：批量重生成会应用它，清空放到 finally，失败时也不残留污染下一次单项重生成 */
function collectBatchFeedback(areas: Array<"figure" | "item" | "bg" | "cg">): string | undefined {
  const text = areas.map((a) => assetFeedback.value[a]?.trim()).filter(Boolean).join("；");
  return text || undefined;
}

function clearBatchFeedback(areas: Array<"figure" | "item" | "bg" | "cg">): void {
  for (const a of areas) assetFeedback.value[a] = "";
}
const voiceChapterFilter = ref(0);
const voiceCharFilter = ref("");

// 素材大图预览（点击缩略图放大）
const preview = ref<{ path: string; label: string } | null>(null);

// 素材重生成：可中断 + 实时进度
const regenAbort = ref(false);
/** 已点「停止」但仍有在途请求：按钮转「正在停止…」并禁用，任务全部结束后自动复位 */
const stopping = ref(false);
/** 已发出停止请求（B27）：stopping 只能由「实际在途任务归零」复位，不能因某个标志抢先置 false 而瞬时消失 */
let pendingStop = false;
watch([busy, assetBusy, queueRunning, stopping], () => {
  // B27：只有 busy/assetBusy/queueRunning 全部归零（真正的在途任务结束）才复位 stopping。
  // stopChapterQueue 不再预先置 queueRunning=false，所以这里不会在章节还在跑时误复位。
  if (!busy.value && !assetBusy.value && !queueRunning.value) {
    if (pendingStop) {
      pendingStop = false;
      pushLog({ step: "中止", message: "已停止：在途任务已结束，已生成的内容保留", level: "info", at: Date.now() });
    }
    stopping.value = false;
  }
  runStatusSync(busy.value, assetBusy.value, queueRunning.value, stopping.value);
});
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
        for (const ct of r.costumes) add(`figure:${r.id}:ct_${ct.id}`);
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

/** 语音行选择（与图像选择分开，避免 key 语义混用）：逐行批量重配用 */
const selectedVoice = ref<Set<string>>(new Set());
const selectedVoiceCount = computed(() => selectedVoice.value.size);
function toggleVoiceSelected(key: string): void {
  const s = new Set(selectedVoice.value);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  selectedVoice.value = s;
}
function selectAllVoice(keys: string[]): void {
  selectedVoice.value = new Set(keys);
}
function clearVoiceSelected(): void {
  selectedVoice.value = new Set();
}

/** 选择键 → 图像任务匹配：三视图选中会级联该角色的立绘/动作（与单张重生成语义一致） */
async function regenSelected(): Promise<void> {
  const keys = Array.from(selected.value);
  if (!keys.length) return;
  // 先过前置（regenCtx 会拦 busy/queueRunning 并记日志），再记「开始」——否则忙时会出现
  // 「批量重生成开始」紧跟「已有任务正在执行中」的自相矛盾日志
  const ctx = await regenImageCtx();
  if (!ctx) return;
  // 计费批量操作前置确认
  if (!window.confirm(`将重新生成已选 ${keys.length} 项（覆盖现有版本；图像 API 会计费）。继续吗？`)) return;
  // 意见框只作用于「同分区」：跨分区批量应用会把 A 分区意见张冠李戴到 B 分区任务；
  // 跨分区时不消费也不清空（保留给对应分区的单项/同分区批量），仅明确提示
  const feedbackAreas = feedbackAreasForKeys(keys);
  const singleArea = feedbackAreas.length <= 1;
  const batchFeedback = singleArea ? collectBatchFeedback(feedbackAreas) : undefined;
  if (!singleArea && feedbackAreas.some((a) => assetFeedback.value[a]?.trim())) {
    pushLog({ step: "素材", message: "跨分区批量重生成不应用意见框内容（避免张冠李戴）：意见仅对同分区单项/同分区批量生效，内容已保留", level: "warn", at: Date.now() });
  }
  pushLog({
    step: "素材",
    message: `批量重生成开始：${keys.length} 项（${keys.slice(0, 5).join("、")}${keys.length > 5 ? "…" : ""}）${batchFeedback ? `；带意见：${batchFeedback.slice(0, 60)}` : ""}`,
    level: "info",
    at: Date.now(),
  });
  assetBusy.value = `batch:${keys.length} 项`;
  resetRegenState();
  try {
    const { signal, onProgress } = regenCtl();
    const predicate = (t: ImageTask) => keys.some((k) => imageTaskMatchesSelectionKey(t, k));
    const stats: RegenBatchStats = { failed: 0, aborted: false, failedTasks: [] };
    const results = await regenerateImages(ctx, predicate, batchFeedback, signal, onProgress, stats);
    // 全部失败时保留选择，用户可直接再点一次重试；有成功则清空（本次选择已消费）
    if (results.length) selected.value = new Set();
    await afterAssetRegen("批量重生成", results.length, stats);
  } catch (e) {
    pushLog({ step: "素材", message: `批量重生成失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    if (singleArea) clearBatchFeedback(feedbackAreas);
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
  const ctx = await regenImageCtx();
  if (!ctx) return;
  if (assetBusy.value) {
    pushLog({ step: "素材", message: "补全缺失图片未执行：已有任务正在执行中，请等待完成后再试", level: "warn", at: Date.now() });
    return;
  }
  // 扫描期间也占用 busy：否则预检（逐任务查文件）期间再点一次会并发启动两批生成
  assetBusy.value = "补全缺失图片（检查中…）";
  resetRegenState();
  try {
    const cacheRoot = `${ctx.outputDir}/.novel2vn/cache`;
    const approvedBible = ctx.visualBible?.status === "approved" ? ctx.visualBible : undefined;
    // 与 regenerateImages 同口径：先跨章去重再建任务，否则预检的 task identity 与实跑不一致
    dedupeSceneIdsAcrossChapters(ctx.chapters);
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
    /** 已生成图在映射里的实际路径（批准守门后三视图存于 visual-bible 目录，不在 cache/images） */
    const mappedPathOf = (t: ImageTask): string | undefined => {
      const m = assetMap.value;
      if (!m) return undefined;
      if (t.kind === "background") return m.bg[t.id];
      if (t.kind === "cg") return m.cg[t.id];
      if (t.kind === "item") return m.item[t.id];
      return m.figure[t.id];
    };
    // 预检缺失：任务文件在 cache/images 下不存在（含 .png/.jpg/.webp 变体）或尺寸不符（与管线分区同口径）
    const missingTaskKeys = new Set<string>();
    pushLog({
      step: "素材",
      message: `补全缺失图片：共 ${allTasks.length} 个图像任务，正在逐个检查文件是否存在…`,
      level: "info",
      at: Date.now(),
    });
    for (const t of allTasks) {
      if (regenAbort.value) {
        pushLog({ step: "素材", message: "补全缺失图片已中断（检查阶段，未开始生成）", level: "warn", at: Date.now() });
        return;
      }
      if (t.kind === "anchor") continue; // 锚点不在素材映射里，跳过
      // 映射里已指向存在文件的任务（含守门目录里的三视图）不算缺失，避免把批准过的三视图重画一遍
      const mapped = mappedPathOf(t);
      if (mapped) {
        try {
          if (await tauri.pathExists(mapped)) continue;
        } catch {
          /* 查询失败继续走缓存目录预检 */
        }
      }
      const base = `${cacheRoot}/images/${t.fileName.replace(/\.png$/i, "")}`;
      // 与管线分区同口径：变体命中＋尺寸相符才算存在，否则进缺失补生成
      let found: string | null = null;
      for (const ext of ["png", "jpg", "jpeg", "webp"]) {
        const candidate = `${base}.${ext}`;
        try {
          if (await tauri.pathExists(candidate)) {
            found = candidate;
            break;
          }
        } catch {
          /* ignore */
        }
      }
      if (found && t.width > 0 && t.height > 0) {
        try {
          if (!(await tauri.imageSizeMatches(found, t.width, t.height).catch(() => true))) found = null;
        } catch {
          /* 查询失败视为命中 */
        }
      }
      if (!found) missingTaskKeys.add(imageTaskIdentity(t));
    }
    if (!missingTaskKeys.size) {
      pushLog({ step: "素材", message: "没有缺失的图片，无需补全", level: "info", at: Date.now() });
      return;
    }
    if (!window.confirm(`发现 ${missingTaskKeys.size} 张缺失图片，将补齐生成（图像 API 计费；已存在的图不动）。继续吗？`)) return;
    assetBusy.value = `补全缺失图片（${missingTaskKeys.size} 张）`;
    const { signal, onProgress } = regenCtl();
    const predicate = (t: ImageTask) => missingTaskKeys.has(imageTaskIdentity(t));
    // 全库补缺不消费意见框：跨分区意见会张冠李戴到每个任务；内容保留给单项/同分区批量使用
    if (assetFeedback.value.figure?.trim() || assetFeedback.value.item?.trim() || assetFeedback.value.bg?.trim() || assetFeedback.value.cg?.trim()) {
      pushLog({ step: "素材", message: "补全缺失图片不读取意见框内容（意见仅对单项/同分区批量生效）：内容已保留", level: "info", at: Date.now() });
    }
    const stats: RegenBatchStats = { failed: 0, aborted: false, failedTasks: [] };
    const results = await regenerateImages(ctx, predicate, undefined, signal, onProgress, stats);
    await afterAssetRegen("补全缺失图片", results.length, stats);
  } catch (e) {
    pushLog({ step: "素材", message: `补全缺失图片失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    resetRegenState();
    await loadAssetMapNow(true);
  }
}

const FIGURE_EMOTIONS = ["normal", "happy", "sad", "angry", "surprised"];
// 语言切换后表情标签需实时更新：computed（模块级一次性 t() 会停留在旧语言）
const EMOTION_LABELS = computed<Record<string, string>>(() => ({ normal: t("默认"), happy: t("开心"), sad: t("悲伤"), angry: t("愤怒"), surprised: t("惊讶") }));

/** 单张素材重新抠图：不动原图，只重跑抠图出透明底；完成后刷新素材映射（仅立绘/物品，背景/CG 不抠） */
async function reCutout(mapKey: "figure" | "item", assetKey: string, filePath: string): Promise<void> {
  if (!filePath || !projectState.outputDir) {
    pushLog({ step: "素材", message: `抠图未执行：${assetKey || "未知素材"}缺少文件路径或输出目录`, level: "warn", at: Date.now() });
    return;
  }
  if (assetBusy.value) {
    pushLog({ step: "素材", message: `抠图未执行：${assetKey}——已有任务正在执行中，请等待完成后再试`, level: "warn", at: Date.now() });
    return;
  }
  assetBusy.value = `cutout:${assetKey}`;
  try {
    const newPath = await reCutoutAsset(projectState.outputDir, mapKey, assetKey, filePath, (ev) => pushLog(ev));
    if (newPath && newPath !== filePath) {
      pushLog({ step: "素材", message: `抠图完成：${assetKey} → 透明底 PNG`, level: "success", at: Date.now() });
      // 抠图产生了新文件：重新组装，把新图复制进游戏目录（否则预览里还是旧图）。
      // execute 会在 assetBusy 非空时直接拒绝，必须先让出占用。
      assetBusy.value = "";
      const ok = await execute({ stages: ["assemble"] });
      if (!ok) {
        pushLog({ step: "素材", message: `抠图完成但重新组装未完成（预览可能仍是旧图）；请稍后手动点「组装」（免费）`, level: "warn", at: Date.now() });
      }
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
    // 无 assets.json / 解析失败：用空映射而不是 null。
    // 否则素材页会退化成「暂无素材」空态，把「补全缺失图片 / 恢复映射 / 清理」整个工具栏一起藏掉。
    assetMap.value = emptyAssetMap();
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
  // 表情/服装行与管线 buildImageTasks 同口径：关闭表情差分→仅默认；核心档→标准5；
  // 完整档→AI 自定义表情集（缺省标准5）；服装差分仅完整档有任务
  const useEmotions = projectState.options.figureEmotions !== false;
  const core = projectState.options.figureDetail === "core";
  return r.cards.characters.map((c) => {
    const emos = !useEmotions ? ["normal"] : core ? FIGURE_EMOTIONS : (c.emotions?.length ? c.emotions : FIGURE_EMOTIONS);
    return {
      id: c.id,
      name: c.name,
      hasRef: !!c.referenceImage,
      threeView: assetMap.value!.figure[`${c.id}_threeview`],
      emotions: emos.map((emo) => ({ emo, file: assetMap.value!.figure[emo === "normal" ? c.id : `${c.id}_${emo}`] })),
      actions: (c.actions || []).map((a) => ({ id: a.id, name: a.name, file: assetMap.value!.figure[`${c.id}_act_${a.id}`] })),
      costumes: core ? [] : (c.costumes || []).map((ct) => ({ id: ct.id, name: ct.name, file: assetMap.value!.figure[`${c.id}_ct_${ct.id}`] })),
    };
  });
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
    ch.scenes.flatMap((s) => {
      const main = s.lines.map((line, i) => {
        const key = `ch${ch.chapter}_${sanitizeId(s.id)}_${i}`;
        const file = assetMap.value!.vocal[key];
        const failed = !file && failedVocalKeys.value.has(key);
        if (line.type === "dialogue") {
          return { key, chapter: ch.chapter + 1, scene: s.location, charId: line.characterId, displayName: charNameOf.value(line.characterId), text: line.text, file, failed, branch: "" };
        }
        // 旁白/独白默认隐藏（避免配音表看起来断裂）；打开开关后显示，key 与配音任务一致
        if (!showNarrationVoice.value) return null;
        return { key, chapter: ch.chapter + 1, scene: s.location, charId: "narrator", displayName: line.monologue ? t("内心独白") : t("旁白"), text: line.text, file, failed, branch: "" };
      });
      // 分支选项台词：key 公式与 buildVoiceJobs 完全一致（lines.length + 1000*(b+1) + j），否则分支配音隐形
      const branches = (s.choices || []).flatMap((choice, b) =>
        choice.lines.map((line, j) => {
          const key = `ch${ch.chapter}_${sanitizeId(s.id)}_${s.lines.length + 1000 * (b + 1) + j}`;
          const file = assetMap.value!.vocal[key];
          const failed = !file && failedVocalKeys.value.has(key);
          const branch = `分支「${choice.prompt}」`;
          if (line.type === "dialogue") {
            return { key, chapter: ch.chapter + 1, scene: s.location, charId: line.characterId, displayName: charNameOf.value(line.characterId), text: line.text, file, failed, branch };
          }
          if (!showNarrationVoice.value) return null;
          return { key, chapter: ch.chapter + 1, scene: s.location, charId: "narrator", displayName: line.monologue ? t("内心独白") : t("旁白"), text: line.text, file, failed, branch };
        }),
      );
      return [...main, ...branches];
    }),
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

// 筛选/开关变化后重置分页：否则停留在旧的「已显示 N 条」，换筛选后前 100 条以外的行看不到
watch([voiceChapterFilter, voiceCharFilter, showNarrationVoice], () => {
  voiceLimit.value = 100;
});
// 换项目/换结果时重置筛选与试听：旧章号在新项目里没有对应选项，列表会假空
watch(() => projectState.outputDir, () => {
  voiceChapterFilter.value = 0;
  voiceCharFilter.value = "";
  stopVoicePlayback();
});

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
  /** 单章强制重跑的 novel index（跳过剧本缓存直接重写；同范围图像背景/CG 同步强制） */
  rerunChaptersForce?: number[];
  /** 只强制重写这些章节的剧本（novel index）；不牵连其他章节与图像 */
  forceScriptChapters?: number[];
  /** 只强制重画这些章节的背景/CG（novel index）；剧本、人物/物品不动 */
  forceImageChapters?: number[];
  /** 只强制重配这些章节的台词配音（novel index） */
  forceVoiceChapters?: number[];
  /** 单章节模式保护：缺剧本缓存时在组装前中止，避免游戏缩水 */
  requireFullScriptCoverage?: boolean;
  /** 纯追加式增量加更：旧全文 + 新增文本（要求 stages 含 split+extract+script） */
  append?: { baseFullText: string; tailText: string };
  /** 队列内部调用：允许在 queueRunning 期间执行（否则排队时外部按钮会被全部拦截） */
  fromQueue?: boolean;
}

async function execute(opts: ExecuteOptions): Promise<boolean> {
  error.value = "";
  if (busy.value || assetBusy.value || (queueRunning.value && !opts.fromQueue)) {
    // 明确反馈而不是静默返回：否则调用方可能已经写出了"开始"日志，用户看到的却是按钮毫无反应
    const busyWhat = queueRunning.value && !opts.fromQueue
      ? "逐章队列"
      : assetBusy.value
        ? `素材重生成（${assetBusy.value}）`
        : "生成任务";
    error.value = `已有${busyWhat}正在运行，本次操作未执行：请等它完成，或先点「停止」再试`;
    pushLog({ step: "生成", message: error.value, level: "warn", at: Date.now() });
    return false;
  }
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
    // 「已准备好」= 磁盘/内存里真的有卡片（空壳 lastResult 不算），否则会跳过文本准备，
    // 让用户在没有任何角色卡时被直接丢到空的视觉守门页。
    const hasPreparedCards = (projectState.lastResult?.cards?.characters?.length ?? 0) > 0;
    const preparationStages = imageRunPreparationStages(opts.stages, hasPreparedCards);
    if (preparationStages.length) {
      const prepared = await execute({
        ...opts,
        stages: preparationStages,
        clearLogsFirst: opts.clearLogsFirst,
      });
      if (!prepared) return false;
    } else if (!hasPreparedCards) {
      error.value = t("请先运行文本阶段，生成角色卡片后再确认视觉守门");
      tab.value = "settings";
      return false;
    }
    // 章节范围要用「本次实际生效的值」：opts 未显式给定时沿用全局勾选（与后面管线启动同口径），
    // 否则批准续跑时 undefined 会被当成 null=全书，把「仅第 N 章」放大成全部章节。
    const resumeChapters = opts.rerunChapters !== undefined ? opts.rerunChapters ?? null : rerunChapters.value ?? null;
    setPendingResume(resumeStagesAfterVisualApproval(opts.stages), {
      rerunChapters: resumeChapters,
      forceImageChapters: opts.forceImageChapters,
      forceVoiceChapters: opts.forceVoiceChapters,
      // 全量开关与意见也必须记住：批准后按原样续跑（否则用户点过「全量」却被静默降级为只补缺失）
      forceStages: opts.forceStages,
      feedback: opts.feedback,
    });
    tab.value = "settings";
    pushLog({
      step: "视觉守门",
      message: t("图像生成前需要确认视觉守门；文本阶段已准备，请选择来源并创建/重新确认草稿"),
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
  // 本次运行的阶段门控＋指示器无条件重置（UI57：上次运行结束不清空，从这里开始才清）：
  // 单阶段重跑不再点亮无关阶段，缓存复用日志也不再叠加到上次的进度上
  clearRunLabels();
  activeRunLabels.value = opts.stages.map((s) => STAGE_LABELS[s]);
  liveProgress.value = null;
  if (projectState.options.skipCache && opts.stages.some((s) => s !== "assemble")) {
    pushLog({
      step: "提示",
      message: t("注意：已开启「跳过缓存（全量重跑）」，本次将忽略全部缓存、全量重新生成并计费；若只想补缺失项请先关闭该开关"),
      level: "warn",
      at: Date.now(),
    });
  }
  // B36：运行开始时重置「最近活跃阶段」——否则置 busy 的瞬间看板会把上一轮的阶段显示成「进行中」
  resetActiveStage();
  busy.value = true;
  projectState.running = true;
  // 本次运行的失败任务从这里重新累计（旧值只用于展示上一轮，不能污染本轮的成功/失败判定）
  lastRunFailedTasks.value = [];
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
    // 本次运行实际生效的章节范围：显式传入优先，否则沿用全局勾选。
    // 必须与下面日志用同一个值——否则日志会写「全部」而实际只跑勾选的几章，事后无法对账。
    const effectiveRerunChapters =
      opts.rerunChapters !== undefined ? opts.rerunChapters ?? undefined : rerunChapters.value ?? undefined;
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
        rerunChapters: effectiveRerunChapters,
        rerunChaptersForce: opts.rerunChaptersForce,
        forceScriptChapters: opts.forceScriptChapters,
        forceImageChapters: opts.forceImageChapters,
        forceVoiceChapters: opts.forceVoiceChapters,
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
      message: `管线启动（阶段：${opts.stages.map((s) => STAGE_LABELS[s]).join(" → ")}`
        + `；章节：${chapterScopeText(effectiveRerunChapters, "全部")}`
        + `${opts.forceStages?.length ? `；强制：${opts.forceStages.map((s) => STAGE_LABELS[s]).join("、")}` : ""}`
        + `${opts.feedback && Object.keys(opts.feedback).length ? `；意见：${Object.keys(opts.feedback).join("、")}（该阶段全量重生成）` : "；意见：无（复用缓存、只补缺失）"}`
        + `${opts.append ? `；增量追加：新增约 ${opts.append.tailText.length} 字` : ""}`
        + `${projectState.options.skipCache ? "；跳过缓存：开（全量重跑）" : ""}`
        + `；人物图：${projectState.options.figureDetail === "core" ? "核心档" : "完整档"}）`,
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
    // B13：pipeline 返回的 splitChapters 是含每章正文的完整 ChapterInfo（整本正文的又一份引用）。
    // 先留完整引用用于更新 novel.chapters；result 上只保留轻量元数据再常驻 lastResult
    //（正文已完整保存在 novel.chapters 与 split.json），避免整本正文在 lastResult 中再驻留一份。
    const fullSplitChapters = result.splitChapters;
    if (fullSplitChapters?.length) {
      result.splitChapters = fullSplitChapters.map((c) => ({
        index: c.index,
        title: c.title,
        charCount: c.charCount ?? c.text?.length ?? 0,
      })) as typeof result.splitChapters;
    }
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
    // 本次运行的失败项（成功返回也可能带部分失败：剧本某章失败、图片若干张失败），
    // 供单章/队列如实汇报"完成但有失败项"，而不是一律当成功
    lastRunFailedTasks.value = result.failedTasks ?? [];
    addRecentOutputDir(result.meta.outputDir);
    upsertProject(result.meta.outputDir, projectState.novel ? { fileName: projectState.novel.fileName, title: projectState.novel.chapters[0]?.title ?? "" } : undefined);
    // 分章来源徽标：本次跑了分章（或透出来源）就直接更新，免一次读盘
    if (result.splitMethod !== undefined) {
      splitMeta.value = {
        method: result.splitMethod,
        stale: false,
        discarded: result.splitDiscarded ?? 0,
        count: result.splitChapters?.length ?? projectState.novel?.chapters.length ?? 0,
      };
    }
    if (fullSplitChapters?.length && projectState.novel) {
      const split = fullSplitChapters;
      const wasMerged = projectState.novel.chapters.length <= 1 && projectState.novel.chapters[0]?.title === "全文";
      if (wasMerged || split.length > 1) {
        const beforeSig = projectState.novel.chapters.map((c) => c.title).join("|");
        // 新分章默认全部启用（不继承旧章节的 enabled，避免旧第 0 章被停用时所有新章全被停用）
        projectState.novel.chapters = split.map((c) => ({ ...c, enabled: c.enabled !== false }));
        logger.info("page", "分章结果已写入项目", { chapterCount: split.length, titles: split.map((c) => c.title).slice(0, 8) });
        // 分章变化后旧勾选会打错章（合法编号指向不同原文）：直接重置为全选并明示
        const afterSig = projectState.novel.chapters.map((c) => c.title).join("|");
        if (beforeSig !== afterSig) {
          rerunChapters.value = null;
          splitConfirmed.value = false;
          // 分章变化后旧的逐章选择索引会指向不同原文：直接清空，避免「生成选中」打错章
          selectedChapters.value = [];
          try {
            localStorage.removeItem(splitConfirmKey());
          } catch {
            /* 忽略 */
          }
          log({ step: "分章", message: `分章已变化（${split.length} 章），重跑勾选已重置为全选、分章确认已失效：请核对章节后重新勾选并确认分章`, level: "warn", at: Date.now() });
        }
      }
    }
    if (opts.stages.includes("assemble")) {
      await checkVideos();
      await loadAssetMapNow(true);
    }
    // 完成后不再自动切换结果标签（进度与日志已在主页面常驻，产物抽屉保持收起不打扰）
    log({ step: "完成", message: `全部完成！项目输出到 ${result.meta.outputDir}，可前往「预览」页试玩`, level: "success", at: Date.now() });
    return true;
  } catch (e) {
    const msg = errMsg(e);
    logger.error("page", "生成失败", { message: msg });
    // 中途失败/中止也刷新素材：已增量落盘的图片保留并显示，重跑时只补缺失项
    void loadAssetMapNow(true);
    // 收回 Pipeline 已记录的失败任务，避免中止/崩溃后「失败项」丢失。
    // 无条件赋值：失败但没有任务记录时也要清掉上一轮的残留，否则本轮判定会被旧失败污染
    lastRunFailedTasks.value = pipelineRef.value?.getFailedTasks?.() ?? [];
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
    // UI57：此处不清空 activeRunLabels——本次运行的阶段标记（含「跳过」）保留到下一次运行开始，
    // 由 execute 开头的 clearRunLabels() 统一清掉。
    void stageStatus.refresh();
    void chapterStatus.refresh();
    // 运行日志自动落盘（含失败/中止）：下次出事先看 .novel2vn/logs/run-*.log
    void persistRunLog();
    // 失败列表以 failed.json 为准刷新：重跑成功的章节/图片/配音立即从页面消失
    void refreshFailedTasks();
  }
}

/** 每次管线运行结束自动落盘一份运行日志（成功失败都存，最多保留 10 份）：
 * 事故复盘不再依赖"我贴日志"——.novel2vn/logs/run-<时间>.log 直接可查。 */
async function persistRunLog(): Promise<void> {
  const out = projectState.outputDir;
  if (!out) return;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const lines = [
      `NovelForge 运行日志 ${stamp}`,
      `项目：${out}`,
      `失败项：${failedTasks.value.length} 个`,
      "",
      ...projectState.logs.map((l) => `[${new Date(l.at).toLocaleTimeString()}] [${l.step}] ${l.message}`),
    ];
    await tauri.mkdirAll(`${out}/.novel2vn/logs`).catch(() => {});
    await tauri.writeTextFile(`${out}/.novel2vn/logs/run-${stamp}.log`, lines.join("\n"));
    const entries = await tauri.listDir(`${out}/.novel2vn/logs`).catch(() => []);
    const runs = entries
      .filter((e) => !e.isDir && /^run-.*\.log$/.test(e.name))
      .map((e) => e.name)
      .sort();
    while (runs.length > 10) {
      const old = runs.shift()!;
      await tauri.removePath(`${out}/.novel2vn/logs/${old}`).catch(() => {});
    }
  } catch {
    /* 落盘失败不打扰 */
  }
}

function start(): void {
  if (busy.value || queueRunning.value) return;
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
  if (prepared) tab.value = "settings";
}

async function resumeAfterVisualApproval(): Promise<void> {
  // 只认「被守门挡下的那次运行」记下的计划；计划为空就是只盖章、不生成。
  const stages = approvalResumePlan(pendingResumeStages.value);
  const scope = pendingResumeScope.value;
  if (!stages.length) {
    clearPendingResume();
    tab.value = "run";
    pushLog({
      step: "视觉守门",
      message: "视觉守门已批准。本次没有待续跑的阶段（批准只盖章，不会自动生成）：需要出图请点顶部横幅/章节盘的「图像」或在「整书生成」里开始",
      level: "info",
      at: Date.now(),
    });
    return;
  }
  // 有任务在跑时不并发第二条管线（批准会启动图像/配音续跑，两边同时写同一目录会互相覆盖）；
  // 保留待续跑计划没用——批准已落库、按钮不会再可点，所以直接提示用户手动补跑。
  if (busy.value || assetBusy.value || queueRunning.value) {
    clearPendingResume();
    pushLog({
      step: "视觉守门",
      message: "当前有任务正在运行，本次未续跑（视觉守门已批准并生效）；请等任务结束后在章节盘点「图像」或在「整书生成」里补跑，避免两条管线同时写同一项目",
      level: "warn",
      at: Date.now(),
    });
    return;
  }
  // 消费掉计划：批准只生效一次，避免第二次点批准把同一批阶段重放（重放 = 再烧一遍图像费用）
  clearPendingResume();
  const scopeText = chapterScopeText(scope?.rerunChapters);
  const fullNote = scope?.forceStages?.length
    ? `；全量阶段：${scope.forceStages.map((s) => STAGE_LABELS[s]).join("、")}`
    : "";
  if (!window.confirm(
    `视觉守门已批准，继续跑：${stages.map((s) => STAGE_LABELS[s]).join(" → ")}\n范围：${scopeText}${fullNote}\n`
    + "（复用已有缓存、只补缺失；守门里的风格/三视图有变化时，相关图片会重画，图像/配音会计费）\n继续吗？",
  )) {
    pushLog({
      step: "视觉守门",
      message: `已取消续跑（${stages.map((s) => STAGE_LABELS[s]).join(" → ")}）；视觉守门已是批准状态，随时可单独点对应阶段补跑`,
      level: "warn",
      at: Date.now(),
    });
    return;
  }
  pushLog({
    step: "视觉守门",
    message: `视觉守门已批准，续跑剩余阶段：${stages.map((s) => STAGE_LABELS[s]).join(" → ")}（${scopeText}${fullNote}）`,
    level: "info",
    at: Date.now(),
  });
  await execute({
    stages,
    rerunChapters: scope?.rerunChapters ?? null,
    forceImageChapters: scope?.forceImageChapters,
    forceVoiceChapters: scope?.forceVoiceChapters,
    forceStages: scope?.forceStages,
    feedback: scope?.feedback,
    clearLogsFirst: false,
  });
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
 * 重新生成某个阶段。默认语义 =「只跑该阶段 + 自动补齐下游缺失资产」：
 * - 缓存命中复用、只补缺失/失败项，不整批重跑；只有填了意见或勾了全量才强制该阶段全量重生成
 *   （分章除外：点击即重新分章）。
 * - 跑完后若下游（图像/配音/组装）还有没生成的，自动算出一份补齐计划、统一确认一次后连续执行
 *   （见 cascadeDownstream）；组装为本地操作，不计费。
 * - 关闭「跑完自动补齐下游」即恢复旧的严格单阶段语义：下游需手动依次重跑。
 */
function runStageRegen(stage: StageKey): void {
  const fb = stageFeedback.value[stage]?.trim() || "";
  const forceAll = !!stageForce.value[stage];
  // 全量路径（填意见或勾全量）执行前二次确认并明示影响（防"填一句意见烧掉全书"）；
  // 两者都无 = 安全的只补缺失
  if (!confirmStageOpinion(stage, fb, forceAll)) return;
  // 分章点击即全书重分（有 LLM 时计费），与其它阶段的"补缺"语义不同：执行前显式确认，取消则不落开始日志
  if (stage === "split" && !window.confirm("「分章」重新生成即全书重新分章（有 LLM 时计费；章节边界变化会使下游剧本/图像/配音缓存按指纹作废重跑）。继续吗？")) {
    pushLog({ step: "分章", message: "已取消重新分章：未执行任何操作", level: "info", at: Date.now() });
    return;
  }
  const failedFor = failedTasks.value.filter((f) => stageStatus.STEP_TO_STAGE[f.step] === stage);
  // 分章没有"补缺"概念：语义必须是"全书重新分章"，不能沿用"复用缓存、只补缺失"的文案
  const semantics = stage === "split"
    ? "全书重新分章（下游缓存按指纹作废）"
    : fb || forceAll
      ? "全量强制重生成"
      : "复用缓存、只补缺失";
  pushLog({
    step: "单阶段",
    message: `重跑「${STAGE_LABELS[stage]}」（${fb ? "带意见" : forceAll ? "勾全量" : "无意见"}：${semantics}；章节：${chapterScopeText(rerunChapters.value)}${failedFor.length ? `；该阶段失败项 ${failedFor.length} 个` : ""}）`,
    level: "info",
    at: Date.now(),
  });
  const feedback = fb ? ({ [stage]: fb } as Partial<StageFeedback>) : undefined;
  // 全量 = 填意见或勾全量开关（后者不需要写意见）
  const full = fb !== "" || forceAll;
  const thenRefresh = async (): Promise<void> => {
    await Promise.all([stageStatus.refresh(), loadAssetMapNow(true)]);
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

  /**
   * 单阶段重跑成功后：自动补齐下游缺失的图像/配音/组装（只补缺失、复用缓存），执行前统一确认一次。
   * 组装虽免费但必须重跑——游戏文件里写死了剧本正文与图片/配音路径，不重装预览就还是旧的。
   * 返回 true 表示下游已由本函数接管（已执行 / 已交给视觉守门 / 已明确告知跳过），
   * 调用方据此不再输出旧的「下游需手动依次重跑」提示。
   */
  async function cascadeDownstream(trigger: StageKey): Promise<boolean> {
    if (!autoCascadeDownstream.value || !CASCADE_TRIGGERS.has(trigger)) return false;
    const result = projectState.lastResult;
    if (!result?.cards) return false;
    const plan = planStageCascade({
      completed: { ...stageStatus.base },
      enabled: { image: projectState.options.useImage, voice: projectState.options.useTts },
      trigger,
      chapters: result.chapters,
      cards: result.cards,
      options: projectState.options,
      assets: assetMap.value ?? undefined,
      tts: activeConfig("tts"),
    });
    if (!plan.stages.length) return false;
    const scale = [
      plan.images ? `图像 ${plan.images} 张` : "",
      plan.voices ? `配音 ${plan.voices} 句` : "",
      plan.stages.includes("assemble") ? "组装（本地刷新，免费）" : "",
    ].filter(Boolean).join("、");
    if (!window.confirm(`下游还有内容没生成，是否现在补齐？\n将生成：${scale}\n（复用已有缓存，只补缺失项；图像/配音会计费）`)) {
      pushLog({
        step: "级联",
        message: `已跳过下游自动补齐（${scale}）；可稍后再点对应阶段，或直接点「组装」刷新预览`,
        level: "info",
        at: Date.now(),
      });
      return true;
    }
    // 图像要过视觉守门：交给守门页，批准后由 resumeAfterVisualApproval 续跑这批阶段
    if (plan.stages.includes("image") && visualBibleNeedsReview(projectState.visualBible)) {
      setPendingResume(plan.stages, { rerunChapters: rerunChapters.value });
      tab.value = "settings";
      pushLog({
        step: "视觉守门",
        message: `下游待补齐：${plan.stages.map((s) => STAGE_LABELS[s]).join(" → ")}；请先确认视觉守门，批准后自动续跑`,
        level: "info",
        at: Date.now(),
      });
      return true;
    }
    pushLog({
      step: "级联",
      message: `自动补齐下游：${plan.stages.map((s) => STAGE_LABELS[s]).join(" → ")}（${scale}；复用缓存只补缺失）`,
      level: "info",
      at: Date.now(),
    });
    await execute({ stages: plan.stages, clearLogsFirst: false, rerunChapters: null });
    await thenRefresh();
    return true;
  }

  /**
   * 单阶段重跑收尾：先刷新看板与素材映射（级联判定依赖最新状态），再尝试自动补齐下游；
   * 没被接管才输出旧的「下游需手动重跑」提示。
   */
  const afterStage = async (ok: boolean, stage: StageKey, staleHint?: () => void): Promise<void> => {
    try {
      await thenRefresh();
      if (!ok) return;
      if (await cascadeDownstream(stage)) return;
      staleHint?.();
    } catch (e) {
      pushLog({ step: "级联", message: `下游自动补齐失败：${errMsg(e)}`, level: "error", at: Date.now() });
    }
  };

  switch (stage) {
    case "split": {
      // 分章无「补缺」概念：点击即重新分章。分章属文本上游，不在自动级联范围内
      // （重分章后剧本本身要重跑）：下游按指纹自动过期，需手动依次重跑。
      // 管线在「未勾选提取且无卡片缓存」时会直接抛错（分章已完成却报失败），
      // 所以新项目分章单跑时自动带上提取兜底。
      const hasCards = (projectState.lastResult?.cards?.characters?.length ?? 0) > 0;
      const stages: StageKey[] = hasCards ? ["split"] : ["split", "extract"];
      if (!hasCards) pushLog({ step: "分章", message: "还没有角色卡片：本次分章会自动带上「提取」阶段（否则管线在无卡片时中止）", level: "info", at: Date.now() });
      void execute({
        stages,
        feedback: feedback as StageFeedback | undefined,
        forceStages: ["split"],
        rerunChapters: null,
      }).then((ok) => {
        if (ok) { clearFb(); stageForce.value[stage] = false; }
        void afterStage(ok, "split", () => hintDownstreamStale("分章", "翻译 / 提取 / 剧本 / 图像 / 配音"));
      });
      break;
    }
    case "translate": {
      // 全量（意见/开关）→ 全量重翻；否则「继续」：只补未缓存/失败的章节，已翻译的复用缓存
      // 严格单阶段：不联动提取/剧本/图像，下游过期需手动重跑
      const force = full ? (["translate"] as StageKey[]) : undefined;
      void execute({
        stages: ["translate"],
        feedback: feedback as StageFeedback | undefined,
        forceStages: force,
        rerunChapters: null,
      }).then((ok) => {
        if (ok) { clearFb(); stageForce.value[stage] = false; }
        void afterStage(ok, "translate", () => {
          if (full) hintDownstreamStale("翻译", "提取 / 剧本 / 图像 / 配音");
        });
      });
      break;
    }
    case "extract":
      // 全量 → 强制重提取（并作废下游剧本/立绘缓存）；否则复用缓存/补缺。
      // 严格单阶段：不自动重跑剧本/图像，下游过期需手动重跑，避免一次点击烧掉整套下游费用
      void execute({
        stages: ["extract"],
        feedback: feedback as StageFeedback | undefined,
        forceStages: full ? (["extract"] as StageKey[]) : undefined,
        rerunChapters: null,
      }).then((ok) => {
        if (ok) { clearFb(); stageForce.value[stage] = false; }
        void afterStage(ok, "extract", () => {
          if (full) hintDownstreamStale("提取", "剧本 / 图像 / 配音");
        });
      });
      break;
    case "script": {
      const failedChapters = failedFor
        .filter((f) => f.id.startsWith("chapter_"))
        .map((f) => parseInt(f.id.replace("chapter_", ""), 10) - 1);
      // 跑完自动补齐下游缺失的图/配音并重新组装（复用缓存、只补缺失，见 cascadeDownstream）
      const stages: StageKey[] = ["script"];
      if (full) {
        const fbMap: Record<number, string> = {};
        if (fb) for (const c of projectState.novel?.chapters ?? []) fbMap[c.index] = fb;
        void execute({ stages, feedback: fb ? { script: fbMap } : undefined, forceStages: ["script"], rerunChapters: null }).then((ok) => {
          if (ok) { clearFb(); stageForce.value[stage] = false; }
          void loadScripts();
          void afterStage(ok, "script", () => hintDownstreamStale("剧本", "图像 / 配音"));
        });
      } else if (failedChapters.length) {
        // 只重生成失败章节，其余复用缓存
        void execute({ stages, rerunChapters: failedChapters }).then((ok) => {
          if (ok) { clearFb(); stageForce.value[stage] = false; }
          void loadScripts();
          void afterStage(ok, "script", () => hintDownstreamStale("剧本", "图像 / 配音"));
        });
      } else {
        // 「继续」：全部章节复用缓存，缺缓存的补生成，不整批重写（避免白烧 LLM 费用）
        void execute({ stages, rerunChapters: null }).then((ok) => {
          if (ok) { clearFb(); stageForce.value[stage] = false; }
          void loadScripts();
          void afterStage(ok, "script", () => hintDownstreamStale("剧本", "图像 / 配音"));
        });
      }
      // 注意：clearFb 在 .then 里做（跑完才清）；此处同步清会让失败时的意见文本直接丢失
      break;
    }
    case "image": {
      // 全量 → 全量重生成；否则「继续」：缓存命中复用、只补缺失/失败的图
      // 跑完自动补齐下游（缺配音则补；并重新组装刷新预览，组装免费）
      const force = full ? (["image"] as StageKey[]) : undefined;
      void execute({
        stages: ["image"],
        feedback: feedback as StageFeedback | undefined,
        forceStages: force,
      }).then((ok) => {
        if (ok) { clearFb(); stageForce.value[stage] = false; }
        void afterStage(ok, "image", () => {
          pushLog({
            step: "图像",
            message: "仅重跑了「图像」，如需更新预览请手动点「组装」（免费）",
            level: "info",
            at: Date.now(),
          });
        });
      });
      break;
    }
    case "voice": {
      // 全量 → 全书重配；否则「继续」只补缺失配音。
      // 跑完自动补齐下游（并重新组装刷新预览，组装免费）
      const force = full ? (["voice"] as StageKey[]) : undefined;
      void execute({ stages: ["voice"], feedback: feedback as StageFeedback | undefined, forceStages: force }).then((ok) => {
        if (ok) { clearFb(); stageForce.value[stage] = false; }
        void afterStage(ok, "voice", () => {
          pushLog({
            step: "配音",
            message: "仅重跑了「配音」，如需更新预览请手动点「组装」（免费）",
            level: "info",
            at: Date.now(),
          });
        });
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
 * 单章节全链重跑：只动指定章节——
 * 剧本（默认只补缺失：有缓存直接复用；填意见按意见重写；勾全量直接重写）、
 * 图像（仅该章背景/CG，其余复用映射；全量时该章背景/CG 同步强制；人物基础图已有成品的不重建任务）、
 * 组装（本地免费刷新预览）。
 * 带 requireFullScriptCoverage：其他章节缺缓存时在组装前中止，保护已有游戏不缩水。
 * @param opts.fromQueueBatch 队列内部调用：跳过组装（队列结束时统一组装一次）。
 *   否则「顺序补全」在中途章节缺剧本时会被组装保护拦下，首章一失败整条队列就停死。
 * @returns 管线是否成功，供队列顺序调用。
 */
async function runChapterFullRegen(novelIdx: number, opts?: { fromQueueBatch?: boolean }): Promise<boolean> {
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
  // 视觉守门未批准时跳过图像阶段，避免阻断剧本重生成（与原 regenChapter 同策略）；
  // 未配置图像 API 时同样跳过（否则每张图只会在管线里空转报"未配置"，日志却宣称做了图像）
  const imagesBlockedByBible = projectState.options.useImage && visualBibleNeedsReview(projectState.visualBible);
  const imagesUsable = !!activeConfig("image")?.apiKey;
  const canFillImages = projectState.options.useImage && !imagesBlockedByBible && imagesUsable;
  const imageSkipNote = !projectState.options.useImage
    ? ""
    : imagesBlockedByBible
      ? "（视觉守门待确认，跳过图像）"
      : !imagesUsable
        ? "（未配置图像 API，跳过图像）"
        : "";
  const voiceNote = chapterIncludeVoice.value ? "含配音" : "不含配音";
  const fb = scriptChapterFeedback.value[novelIdx]?.trim() ?? "";
  const forceAll = !!chapterForce.value[novelIdx];
  // 全量单章先确认（影响：整章剧本重写＋该章背景/CG 重画）
  if (forceAll && !window.confirm(`第 ${novelIdx + 1} 章「${ch.title}」将全量重跑（剧本重写${canFillImages ? "＋该章背景/CG 重画" : ""}，scene 变化后该章配音需重配）。继续吗？`)) return false;
  chapterForce.value[novelIdx] = false;
  pushLog({
    step: "单章",
    message: `第 ${novelIdx + 1} 章「${ch.title}」全链开始（${fb ? "按意见重写剧本" : forceAll ? "全量重写剧本" : "剧本只补缺失"}${canFillImages ? `＋图像${forceAll ? "（该章背景/CG 强制）" : ""}` : imageSkipNote}，${voiceNote}）`,
    level: "info",
    at: Date.now(),
  });
  // 只补缺失（默认）：无意见无全量时不带 feedback key，管线优先复用该章剧本缓存、只生成缺失部分；
  // 填意见按意见重写；勾全量经 rerunChaptersForce 直接重写（scene.id 会变，该章图片随之重画）。
  // rerunChapters 限定单章，图像 scope 同口径过滤。
  // 单章链可含配音：勾了「含配音」就把 voice 排在组装之前，让一章能独立产出完整内容
  const chapterStages: StageKey[] = ["script"];
  if (canFillImages) chapterStages.push("image");
  if (chapterIncludeVoice.value) chapterStages.push("voice");
  if (!opts?.fromQueueBatch) chapterStages.push("assemble");
  let ok = await execute({
    stages: chapterStages,
    feedback: fb ? { script: { [novelIdx]: fb } } : undefined,
    rerunChapters: [novelIdx],
    rerunChaptersForce: forceAll ? [novelIdx] : undefined,
    requireFullScriptCoverage: true,
    // 仅队列批次入口允许在 queueRunning 期间执行；章节盘/剧本页直接调用必须走互斥守卫
    fromQueue: opts?.fromQueueBatch === true,
  });
  // 本次运行的失败项（成功返回也可能带部分失败：本章剧本失败 / 若干张图失败）
  const runFailures = lastRunFailedTasks.value;
  const chapterFailed = runFailures.some((f) => f.id === `chapter_${novelIdx + 1}`);
  const imageFailed = runFailures.filter((f) => f.step === "图像").length;
  const voiceFailed = runFailures.filter((f) => f.step === "配音").length;
  // 意见/全量只在真的按意见跑成功后才消费：失败时保留，用户可直接再点一次重试
  if (ok && !chapterFailed) scriptChapterFeedback.value[novelIdx] = "";
  if (chapterFailed && forceAll) chapterForce.value[novelIdx] = true;
  void loadAssetMapNow(true);
  // 剧本页没开着就不必全量重读 game/scene（100 章规模下每次单章都读一遍很重）
  if (tab.value === "products") void loadScripts();
  // 章节状态在 execute 的 finally 已全量刷新，这里不再重复
  if (!ok && !opts?.fromQueueBatch && !chapterFailed && error.value.includes("已中止组装以保护已有游戏内容")) {
    // 组装保护：剧本（+图像）其实已经落盘成功，只是还有章节没剧本、组装会缩水被拦。
    // 不能当失败处理——否则用户以为这一章白跑了；提示去队列补齐即可。
    error.value = "";
    ok = true;
    pushLog({
      step: "单章",
      message: `第 ${novelIdx + 1} 章「${ch.title}」剧本已生成；仍有章节缺剧本缓存，本次跳过组装以免游戏缩水——点「顺序补全未完成」补齐全部章节后会统一重新组装（本地免费）`,
      level: "warn",
      at: Date.now(),
    });
  }
  if (chapterFailed) {
    // 管线允许"某章剧本失败、其余继续"，但单章链的目标就是这一章：不能报成功。
    // 无论后续是保护中止（ok=false）还是渐进组装（ok=true），都按失败汇报并让队列停下。
    pushLog({
      step: "单章",
      message: `第 ${novelIdx + 1} 章「${ch.title}」剧本生成失败，本章未完成（可在「失败项」定位重试；重试时会复用已完成部分）`,
      level: "error",
      at: Date.now(),
    });
    return false;
  }
  if (ok) {
    if (imagesBlockedByBible) {
      // 图片被视觉守门挡住时不能只报「已重新生成」——用户会以为全链跑完了，其实一张图都没画。
      // 记好待补阶段（批准后自动补图 + 重新组装），但不抢用户的页面：守门页入口交给顶部横幅。
      setPendingResume(resumeStagesAfterVisualApproval(["script", "image", "assemble"]), {
        rerunChapters: [novelIdx],
        forceImageChapters: [novelIdx],
      });
      pushLog({
        step: "视觉守门",
        message: `第 ${novelIdx + 1} 章「${ch.title}」剧本已重新生成${opts?.fromQueueBatch ? "" : "、预览已组装"}，但该章图片还没生成：视觉守门待确认。去「视觉守门」页（页面顶部横幅有「去确认」按钮）确认并批准后，会自动补齐图像并重新组装`,
        level: "warn",
        at: Date.now(),
      });
    } else if (projectState.options.useImage && !imagesUsable) {
      pushLog({
        step: "单章",
        message: `第 ${novelIdx + 1} 章「${ch.title}」剧本已重新生成、预览已组装；未配置图像 API，该章图片未生成——请在「API 配置」页配置后点「图像」阶段补齐`,
        level: "warn",
        at: Date.now(),
      });
    } else {
      const failureNote = imageFailed + voiceFailed > 0
        ? `；本次有 ${[imageFailed ? `${imageFailed} 个图像任务` : "", voiceFailed ? `${voiceFailed} 个配音任务` : ""].filter(Boolean).join("、")}失败，请到「失败项」查看并补跑（已完成的不会重复计费）`
        : "";
      pushLog({
        step: "单章",
        message: `第 ${novelIdx + 1} 章「${ch.title}」已重新生成（${fb ? "按意见重写剧本，" : forceAll ? "全量重写剧本，" : ""}剧本${canFillImages ? "＋图像" : ""}${fb || forceAll ? "" : "只补缺失"}、${voiceNote}）${opts?.fromQueueBatch ? "；组装待队列结束统一执行" : "；预览已组装"}${chapterIncludeVoice.value ? "" : "。配音请跑配音阶段或在素材页单句重配"}${failureNote}`,
        level: failureNote ? "warn" : "success",
        at: Date.now(),
      });
    }
  }
  return ok;
}

/** 单章「只重跑一部分」：剧本 / 图像 / 配音各自独立，其余内容一律复用缓存。
 * 解决「图错一张、配音欠一句，却要整章甚至整本重跑」的粒度问题。
 * - script：按意见（可选）或强制重写本章剧本；剧本变了该章 scene 即失效，
 *   因此同步强制重画该章背景/CG，避免游戏里留着与正文对不上的旧图。
 * - image：只强制重画本章背景/CG，剧本与配音完全不动（人物/物品是项目级资产，不受影响）。
 * - voice：只强制重配本章台词，剧本与图像不动。
 */
async function runChapterPartRegen(novelIdx: number, part: "script" | "image" | "voice"): Promise<boolean> {
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
  const imageCfg = activeConfig("image");
  const ttsCfg = activeConfig("tts");
  if (part === "image" && !(projectState.options.useImage && imageCfg?.apiKey)) {
    error.value = t("未配置图像生成 API，无法重画图像；请先在「API 配置」页完成配置");
    return false;
  }
  if (part === "voice" && !ttsCfg?.apiKey) {
    error.value = t("未配置 TTS 配音 API，无法重配配音；请先在「API 配置」页完成配置");
    return false;
  }
  const imagesBlockedByBible = projectState.options.useImage && visualBibleNeedsReview(projectState.visualBible);
  const canFillImages = projectState.options.useImage && !imagesBlockedByBible;
  if (part === "image" && imagesBlockedByBible) {
    error.value = t("视觉守门待确认，请先批准再重画图像");
    return false;
  }
  const fb = scriptChapterFeedback.value[novelIdx]?.trim() ?? "";
  const label = part === "script" ? "剧本" : part === "image" ? "图像" : "配音";
  const ask = part === "script"
    ? `第 ${novelIdx + 1} 章「${ch.title}」将${fb ? "按你的意见重写剧本" : "强制重写剧本"}${canFillImages ? "，并按新剧本重画本章背景/CG" : ""}（不含配音）。继续吗？`
    : part === "image"
      ? `只重画第 ${novelIdx + 1} 章「${ch.title}」的背景/CG（剧本、配音不动）。继续吗？`
      : `只重配第 ${novelIdx + 1} 章「${ch.title}」的台词配音（剧本、图像不动）。继续吗？`;
  if (!window.confirm(ask)) return false;

  const exec: ExecuteOptions = {
    stages: [],
    rerunChapters: [novelIdx],
    requireFullScriptCoverage: true,
  };
  if (part === "script") {
    // 只重写本章剧本：不传 rerunChaptersForce（那是「整章全量」），改传 forceScriptChapters，
    // 图像强制只落在本章，其余章节连剧本缓存都不碰。
    exec.stages = canFillImages ? ["script", "image", "assemble"] : ["script", "assemble"];
    exec.feedback = fb ? { script: { [novelIdx]: fb } } : undefined;
    exec.forceScriptChapters = [novelIdx];
    if (canFillImages) exec.forceImageChapters = [novelIdx];
  } else if (part === "image") {
    exec.stages = ["image", "assemble"];
    exec.forceImageChapters = [novelIdx];
  } else {
    exec.stages = ["voice", "assemble"];
    exec.forceVoiceChapters = [novelIdx];
  }
  pushLog({
    step: "单章",
    message: `第 ${novelIdx + 1} 章「${ch.title}」只重跑${label}（其余内容复用缓存，0 计费）…`,
    level: "info",
    at: Date.now(),
  });
  let ok = await execute(exec);
  // 本次运行的失败项：成功返回也可能带部分失败
  const runFailures = lastRunFailedTasks.value;
  const chapterFailed = part === "script" && runFailures.some((f) => f.id === `chapter_${novelIdx + 1}`);
  const imageFailed = runFailures.filter((f) => f.step === "图像").length;
  const voiceFailed = runFailures.filter((f) => f.step === "配音").length;
  // 剧本重写成功才消费意见；失败保留，便于直接重试
  if (part === "script" && ok && !chapterFailed) scriptChapterFeedback.value[novelIdx] = "";
  void loadAssetMapNow(true);
  if (tab.value === "products") void loadScripts();
  // 章节状态在 execute 的 finally 已全量刷新，这里不再重复
  if (
    !ok &&
    !(part === "script" && chapterFailed) &&
    error.value.includes("已中止组装以保护已有游戏内容")
  ) {
    // 与整章链同口径：该部分已成功，只是组装被保护逻辑拦下，不算失败
    // （此前只对剧本部分容错，图像/配音部分会误报红错）
    error.value = "";
    ok = true;
    pushLog({
      step: "单章",
      message: `第 ${novelIdx + 1} 章「${ch.title}」${label}已重跑；仍有章节缺剧本缓存，本次跳过组装以免游戏缩水——补齐其余章节后点「组装」刷新预览`,
      level: "warn",
      at: Date.now(),
    });
  }
  if (part === "script" && chapterFailed) {
    pushLog({
      step: "单章",
      message: `第 ${novelIdx + 1} 章「${ch.title}」剧本重写失败，章节内容未更新（可在「失败项」重试）`,
      level: "error",
      at: Date.now(),
    });
    return false;
  }
  if (ok) {
    const failureNote = imageFailed + voiceFailed > 0
      ? `；本次有 ${[imageFailed ? `${imageFailed} 个图像任务` : "", voiceFailed ? `${voiceFailed} 个配音任务` : ""].filter(Boolean).join("、")}失败，请到「失败项」查看并补跑`
      : "";
    pushLog({
      step: "单章",
      message: `第 ${novelIdx + 1} 章「${ch.title}」${label}已重新生成，其余内容未动；预览已重新组装${failureNote}`,
      level: failureNote ? "warn" : "success",
      at: Date.now(),
    });
  }
  return ok;
}
/** 全量重跑二次确认：明示全量影响（张数/句数/章数），防"填一句意见烧掉全书"。
 * 无意见且未勾全量返回 true（直接执行"继续/补缺"语义）。 */
function confirmStageOpinion(stage: StageKey, fb: string, forceAll = false): boolean {
  if (!fb && !forceAll) return true;
  const how = fb ? "意见" : "全量开关";
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
      // 数字只按全书估算：部分章节范围时不要拿它冒充"范围内"的张数（人物/物品还是全书项目级资产）
      const partialScope = Array.isArray(rerunChapters.value) && rerunChapters.value.length > 0 && rerunChapters.value.length < Math.max(chapters.length, 1);
      return window.confirm(
        `「图像」${how}将强制重画${chapterScopeText(rerunChapters.value)}图片${total ? `（全书任务约 ${total} 张，含人物基础图约 ${figs} 张${partialScope ? "；人物/物品为项目级，不随章节范围收窄" : ""}）` : ""}，会产生图片费用。继续吗？\n（只想改单张图：去素材页点那张图的"重新生成"，意见填在那一区的意见框）`,
      );
    }
    case "script": {
      const n = enabledNovelCount || chapters.length;
      return window.confirm(
        `「剧本」${how}将重写全书 ${n} 章剧本（旧场景图/配音随之过期需重跑）。继续吗？\n（只改一章：去章节盘点那一章的重新生成，意见填在该章意见框）`,
      );
    }
    case "extract":
      return window.confirm(`「提取」${how}将重新提取全部卡片，并作废下游剧本缓存与人物/物品图（背景/CG/配音文件保留）。继续吗？`);
    case "translate": {
      const n = enabledNovelCount || chapters.length;
      return window.confirm(`「翻译」${how}将重翻全书 ${n} 章。继续吗？`);
    }
    case "split":
      return window.confirm(`将按${how}重新分章：分章变化会导致下游剧本/图像/配音缓存过期需重跑。继续吗？`);
    case "voice": {
      let n = 0;
      for (const ch of chapters) {
        for (const s of ch.scenes) {
          n += s.lines.length;
          for (const c of s.choices || []) n += c.lines.length;
        }
      }
      const partialScope = Array.isArray(rerunChapters.value) && rerunChapters.value.length > 0 && rerunChapters.value.length < Math.max(chapters.length, 1);
      return window.confirm(
        `「配音」${how}将${chapterScopeText(rerunChapters.value)}重配${n ? `（全书约 ${n} 句${partialScope ? "，部分章节范围时仅重配范围内台词" : ""}）` : ""}，会产生配音费用。继续吗？\n（只重配一句/一人：去素材页配音区点单句重配或整人重配）`,
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
    `增量追加：在现有 ${novel.chapters.length} 章（约 ${novel.fullText.length} 字）后追加「${fileName}」（约 ${tail.length} 字）。\n旧章节、卡片与全部素材原样保留，只对新增部分分章→提取→生成新章；如有新角色将自动同步加入视觉守门（三视图走图像 API，需去视觉守门页确认）。继续吗？`,
  )) return;
  const stages: StageKey[] = ["split", "extract", "script", "image", "assemble"];
  if ((projectState.options.language ?? "").trim()) stages.splice(1, 0, "translate");
  const prevChapterCount = novel.chapters.length;
  pushLog({
    step: "追加",
    message: `增量追加开始：「${fileName}」约 ${tail.length} 字接在现有 ${novel.chapters.length} 章之后（阶段：${stages.map((s) => STAGE_LABELS[s]).join(" → ")}；旧章节/卡片/素材全部保留）`,
    level: "info",
    at: Date.now(),
  });
  if (projectState.options.useImage) {
    // 追加必然改变小说输入：视觉守门指纹（含全文）随之失效——已批准会被判「输入已变化」直接抛错、
    // 未创建则整次运行被 divert 到守门页（追加文本与内存状态都会丢）。所以追加永不直接跑图像：
    // 先追加文本，图像等守门创建/重新确认后按新增章范围自动补齐。
    stages.splice(stages.indexOf("image"), 1);
    pushLog({
      step: "追加",
      message: projectState.visualBible
        ? "视觉守门需按追加后的输入重新确认：本次先追加文本（分章/提取/剧本），批准后自动按新增章补齐图像并重新组装"
        : "视觉守门尚未创建：本次先追加文本（分章/提取/剧本）；请去「视觉守门」创建并批准，之后会自动按新增章补齐图像",
      level: "warn",
      at: Date.now(),
    });
  }
  const ok = await execute({
    stages,
    append: { baseFullText: novel.fullText, tailText: tail },
    requireFullScriptCoverage: true,
  });
  if (ok) {
    // 更新内存小说：全文拼接；章节由 execute 按本次分章的完整数据（含正文）写入 novel.chapters，
    // 这里不再从 lastResult.splitChapters 覆盖——B13 后它只剩轻量元数据（无 text），覆盖会丢正文。
    const newFull = joinAppendText(novel.fullText, tail);
    novel.fullText = newFull;
    if (/^[a-zA-Z]:[\\/]/.test(label) || label.startsWith("/")) {
      const paths = novel.sourcePaths?.length ? [...novel.sourcePaths] : (novel.sourcePath ? [novel.sourcePath] : []);
      if (!paths.includes(label)) paths.push(label);
      novel.sourcePaths = paths;
    }
    scheduleSave();
    void chapterStatus.refresh();
    // 追加新角色自动同步视觉守门：对比视觉守门条目，缺失的按当前卡片补建三视图（旧人走老路不受影响）；
    // 同步后视觉守门待确认，去视觉守门页确认批准后再跑图像阶段补新章图
    const bibleNote = await syncAppendedCharactersToBible();
    // 新增章 = 旧章数之后的索引（管线把追加部分编在旧章之后）；批准守门后按这个范围补图
    const appendedIndexes = novel.chapters.filter((c) => c.index >= prevChapterCount).map((c) => c.index);
    if (projectState.options.useImage) {
      setPendingResume(resumeStagesAfterVisualApproval(["image", "assemble"]), {
        rerunChapters: appendedIndexes.length ? appendedIndexes : null,
      });
    }
    pushLog({ step: "追加", message: `增量追加完成：现共 ${novel.chapters.length} 章${bibleNote}；新章节配音请跑配音阶段（勾选新章节）或在素材页单句重配`, level: "success", at: Date.now() });
  }
}

/** 追加后视觉守门同步：新角色补建三视图条目。返回日志后缀（无新角色/无视觉守门则为空）。 */
async function syncAppendedCharactersToBible(): Promise<string> {
  const out = projectState.outputDir;
  const bible = projectState.visualBible;
  const cards = projectState.lastResult?.cards;
  if (!out || !bible || !cards?.characters.length) return "";
  const missing = cards.characters.filter((c) => !bible.characters[c.id]);
  if (!missing.length) return "";
  const imageCfg = activeConfig("image");
  if (!imageCfg?.apiKey) {
    pushLog({ step: "追加", message: `新增 ${missing.length} 个角色（${missing.map((c) => c.name || c.id).join("、")}）不在视觉守门中，但未配置图像 API，跳过同步：请配置后去视觉守门页点「同步当前卡片」`, level: "warn", at: Date.now() });
    return "";
  }
  pushLog({ step: "追加", message: `新增 ${missing.length} 个角色（${missing.map((c) => c.name || c.id).join("、")}），正在同步加入视觉守门…`, level: "info", at: Date.now() });
  try {
    const r = await syncBibleCharactersWithCards(out, bible, { characters: cards.characters, imageCfg });
    const novel = projectState.novel;
    if (novel) {
      const fp = await computeProjectVisualBibleFingerprint(out, bible, novel, cards.characters);
      await refreshVisualBibleFingerprint(out, bible, fp, cards.characters);
    }
    scheduleSave();
    pushLog({
      step: "追加",
      message: `视觉守门同步完成：补建 ${r.added.length} 个新角色三视图${r.adopted.length ? `（${r.adopted.length} 个复用孤儿文件免生成）` : ""}${r.failed.length ? `，失败 ${r.failed.length} 个（${r.failed.map((f) => f.name).join("、")}）` : ""}；请去视觉守门页确认后批准，再跑图像阶段补新章图`,
      level: r.failed.length ? "warn" : "success",
      at: Date.now(),
    });
    return `；新角色 ${r.added.length + r.adopted.length} 个已同步加入视觉守门（待确认）`;
  } catch (e) {
    pushLog({ step: "追加", message: `视觉守门同步失败（不影响已追加章节）：${errMsg(e)}；请去视觉守门页手动点「同步当前卡片」`, level: "error", at: Date.now() });
    return "";
  }
}

function regenChapter(idx: number): void {
  // 剧本页的"重新生成此章"即单章节全链（与章节盘一致）
  void runChapterFullRegen(idx);
}

/* ==================== 素材 Tab 操作 ==================== */

async function regenCtx(): Promise<RegenContext | null> {
  // 素材页所有重生成入口共用：前置条件不满足时必须留一条日志，
  // 否则按钮看着可点、点了却毫无反应（曾报"重新生成图片，日志都没有"）。
  if (busy.value || assetBusy.value || queueRunning.value) {
    pushLog({ step: "素材", message: "已有任务正在执行中，本次点击未执行：请等待当前任务完成（或点停止按钮）后再试", level: "warn", at: Date.now() });
    return null;
  }
  const r = projectState.lastResult;
  if (!r) {
    pushLog({ step: "素材", message: "暂无项目数据，本次点击未执行：请先运行文本阶段生成角色卡片", level: "warn", at: Date.now() });
    return null;
  }
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

async function afterAssetRegen(label: string, resultsLength: number, stats?: RegenBatchStats): Promise<void> {
  const failedCount = stats?.failed ?? 0;
  const aborted = stats?.aborted ?? false;
  // 登记失败项：此前素材批量的失败只在日志里，文案却指向「失败项」而列表里没有任何条目
  const failedList = stats?.failedTasks ?? [];
  if (failedList.length) {
    const at = Date.now();
    const incoming: FailedTask[] = failedList.map((ft) => ({
      id: ft.id,
      kind: "image" as const,
      step: "图像",
      message: `${ft.usage}：重生成失败`,
      at,
    }));
    // 去重（同身份保留最新）并落盘：只写内存的话刷新/重启就丢，失败项列表与徽标也会重复膨胀
    lastRunFailedTasks.value = mergeFailedTasks(lastRunFailedTasks.value, incoming);
    const persisted = projectState.lastResult?.failedTasks;
    if (persisted) projectState.lastResult!.failedTasks = mergeFailedTasks(persisted, incoming);
    if (projectState.outputDir) {
      void mutateFailedTasks(projectState.outputDir, (prev) => mergeFailedTasks(prev, incoming)).catch(() => undefined);
    }
    scheduleSave();
  }
  const detail = aborted
    ? `已中断：成功 ${resultsLength} 项${failedCount ? `、失败 ${failedCount} 项` : ""}`
    : failedCount
      ? `成功 ${resultsLength} 项、失败 ${failedCount} 项（可在「失败项」定位并补跑；已完成的不会重复计费）`
      : resultsLength === 0
        ? "没有生成任何内容（任务可能失败，请查看上方日志；也可到「失败项」补跑）"
        : `已重新生成 ${resultsLength} 项`;
  pushLog({
    step: "素材",
    message: `${label}：${detail}，正在重新组装…`,
    level: aborted || failedCount || resultsLength === 0 ? "warn" : "success",
    at: Date.now(),
  });
  // execute 会在 assetBusy 非空时拒绝执行：先让出占用再组装
  assetBusy.value = "";
  const ok = await execute({ stages: ["assemble"] });
  if (!ok) {
    pushLog({
      step: "素材",
      message: `${label}：重新组装未完成（预览可能仍是旧内容）；请稍后在「单阶段重跑」点「组装」刷新（免费）`,
      level: "warn",
      at: Date.now(),
    });
  }
  await loadAssetMapNow(true);
}

/** 图像素材重生成的统一前置：未配置/未启用图像 API 时明确报错，避免点了按钮只得到"已重新生成 0 项" */
async function regenImageCtx(): Promise<RegenContext | null> {
  const ctx = await regenCtx();
  if (!ctx) return null;
  if (!ctx.cfg) {
    pushLog({
      step: "素材",
      message: t("图像生成未启用或未配置 API，无法重生成图片；请在「API 配置」页配置图像模型并在「生成内容」勾选「图像」"),
      level: "warn",
      at: Date.now(),
    });
    return null;
  }
  return ctx;
}

/* ==================== 素材 Tab 单项重生成 ==================== */

/** 单项重生成入口日志：哪一项、带不带意见（结果由 afterAssetRegen 记录张数） */
function logAssetStart(label: string, fb?: string): void {
  pushLog({ step: "素材", message: `开始${label}${fb ? "（带意见）" : ""}…`, level: "info", at: Date.now() });
}

async function regenFigureEmotion(charId: string, emo: string): Promise<void> {
  const ctx = await regenImageCtx();
  if (!ctx) return;
  const fb = assetFeedback.value.figure?.trim() || undefined;
  assetBusy.value = `figure:${charId}:${emo}`;
  resetRegenState();
  logAssetStart(`重生成立绘「${charId}」${EMOTION_LABELS.value[emo] ?? emo}`, fb);
  try {
    const { signal, onProgress } = regenCtl();
    const stats: RegenBatchStats = { failed: 0, aborted: false, failedTasks: [] };
    const results = await regenerateImages(
      ctx,
      (t) => t.kind === "figure" && (emo === "normal" ? t.id === charId : t.id === `${charId}_${emo}`),
      fb,
      signal,
      onProgress,
      stats,
    );
    await afterAssetRegen(`立绘「${charId}」${EMOTION_LABELS.value[emo] ?? emo}`, results.length, stats);
  } catch (e) {
    pushLog({ step: "素材", message: `重新生成立绘失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    assetFeedback.value.figure = "";
    resetRegenState();
  }
}

async function regenAllFigure(charId: string): Promise<void> {
  const ctx = await regenImageCtx();
  if (!ctx) return;
  const fb = assetFeedback.value.figure?.trim() || undefined;
  assetBusy.value = `figure:${charId}`;
  resetRegenState();
  logAssetStart(`重生成立绘「${charId}」（全部表情）`, fb);
  try {
    const { signal, onProgress } = regenCtl();
    const stats: RegenBatchStats = { failed: 0, aborted: false, failedTasks: [] };
    const results = await regenerateCharacterFigures(ctx, charId, fb, signal, onProgress, stats);
    await afterAssetRegen(`立绘「${charId}」（全部表情）`, results.length, stats);
  } catch (e) {
    pushLog({ step: "素材", message: `重新生成立绘失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    assetFeedback.value.figure = "";
    resetRegenState();
  }
}

async function regenThreeView(charId: string): Promise<void> {
  const ctx = await regenImageCtx();
  if (!ctx) return;
  const fb = assetFeedback.value.figure?.trim() || undefined;
  assetBusy.value = `threeview:${charId}`;
  resetRegenState();
  logAssetStart(`重生成三视图「${charId}」（联动默认/表情/动作）`, fb);
  try {
    const { signal, onProgress } = regenCtl();
    const stats: RegenBatchStats = { failed: 0, aborted: false, failedTasks: [] };
    const results = await regenerateCharacterThreeView(ctx, charId, fb, signal, onProgress, stats);
    if (projectState.visualBible?.status === "approved" && projectState.visualBible.characters[charId]) {
      // 素材页重画的三视图不进视觉守门：批准过的锚点仍是旧图，立绘会继续按旧锚点画。
      // 明确提示用户去守门页对该角色重新生成并确认，避免"重画了但没生效"的困惑。
      pushLog({
        step: "视觉守门",
        message: `三视图「${charId}」已在素材页重生成，但视觉守门里该角色的锚点未更新：请去「视觉守门」对该角色点「重新生成三视图」并重新确认，否则立绘/动作仍按守门旧锚点生成`,
        level: "warn",
        at: Date.now(),
      });
    }
    await afterAssetRegen(`三视图「${charId}」（联动重生成默认/表情/动作）`, results.length, stats);
  } catch (e) {
    pushLog({ step: "素材", message: `重新生成三视图失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    assetFeedback.value.figure = "";
    resetRegenState();
  }
}

async function regenAction(charId: string, actionId: string, actionName: string): Promise<void> {
  const ctx = await regenImageCtx();
  if (!ctx) return;
  const fb = assetFeedback.value.figure?.trim() || undefined;
  assetBusy.value = `action:${charId}:${actionId}`;
  resetRegenState();
  logAssetStart(`重生成动作「${actionName}」（${charId}）`, fb);
  try {
    const { signal, onProgress } = regenCtl();
    const stats: RegenBatchStats = { failed: 0, aborted: false, failedTasks: [] };
    const results = await regenerateCharacterAction(ctx, charId, actionId, fb, signal, onProgress, stats);
    await afterAssetRegen(`动作「${actionName}」（${charId}）`, results.length, stats);
  } catch (e) {
    pushLog({ step: "素材", message: `重新生成动作失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    assetFeedback.value.figure = "";
    resetRegenState();
  }
}

async function regenCostume(charId: string, costumeId: string, costumeName: string): Promise<void> {
  const ctx = await regenImageCtx();
  if (!ctx) return;
  const fb = assetFeedback.value.figure?.trim() || undefined;
  assetBusy.value = `costume:${charId}:${costumeId}`;
  resetRegenState();
  logAssetStart(`重生成服装「${costumeName}」（${charId}）`, fb);
  try {
    const { signal, onProgress } = regenCtl();
    const stats: RegenBatchStats = { failed: 0, aborted: false, failedTasks: [] };
    const results = await regenerateImages(
      ctx,
      (t) => t.kind === "figure" && t.id === `${charId}_ct_${costumeId}`,
      fb,
      signal,
      onProgress,
      stats,
    );
    await afterAssetRegen(`服装「${costumeName}」（${charId}）`, results.length, stats);
  } catch (e) {
    pushLog({ step: "素材", message: `重新生成服装失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    assetFeedback.value.figure = "";
    resetRegenState();
  }
}

async function regenItem(id: string): Promise<void> {
  const ctx = await regenImageCtx();
  if (!ctx) return;
  const fb = assetFeedback.value.item?.trim() || undefined;
  assetBusy.value = `item:${id}`;
  resetRegenState();
  logAssetStart(`重生成物品图「${id}」`, fb);
  try {
    const { signal, onProgress } = regenCtl();
    const stats: RegenBatchStats = { failed: 0, aborted: false, failedTasks: [] };
    const results = await regenerateItemImage(ctx, id, fb, signal, onProgress, stats);
    await afterAssetRegen(`物品图「${id}」`, results.length, stats);
  } catch (e) {
    pushLog({ step: "素材", message: `重新生成物品图失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    assetFeedback.value.item = "";
    resetRegenState();
  }
}

async function regenBg(sceneId: string): Promise<void> {
  const ctx = await regenImageCtx();
  if (!ctx) return;
  const fb = assetFeedback.value.bg?.trim() || undefined;
  assetBusy.value = `bg:${sceneId}`;
  resetRegenState();
  logAssetStart(`重生成背景「${sceneId}」`, fb);
  try {
    const { signal, onProgress } = regenCtl();
    const stats: RegenBatchStats = { failed: 0, aborted: false, failedTasks: [] };
    const results = await regenerateBackground(ctx, sceneId, fb, signal, onProgress, stats);
    await afterAssetRegen(`背景「${sceneId}」`, results.length, stats);
  } catch (e) {
    pushLog({ step: "素材", message: `重新生成背景失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    assetFeedback.value.bg = "";
    resetRegenState();
  }
}

async function regenCgRow(chapter: number, sceneId: string): Promise<void> {
  const ctx = await regenImageCtx();
  if (!ctx) return;
  const fb = assetFeedback.value.cg?.trim() || undefined;
  assetBusy.value = `cg:${chapter}:${sceneId}`;
  resetRegenState();
  logAssetStart(`重生成 CG「${sceneId}」（第 ${chapter} 章）`, fb);
  try {
    const { signal, onProgress } = regenCtl();
    const stats: RegenBatchStats = { failed: 0, aborted: false, failedTasks: [] };
    const results = await regenerateCg(ctx, chapter - 1, sceneId, fb, signal, onProgress, stats);
    await afterAssetRegen(`CG「${sceneId}」`, results.length, stats);
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

/** 停止试听并复位按钮态。切换结果 tab / 素材子 tab / 筛选后调用：
 * 音频元素随 v-if 卸载后，旧行会一直停留在「⏸ 停止」且点它也无法真正停止。 */
function stopVoicePlayback(): void {
  playingVoiceKey.value = "";
  if (audioRef.value) {
    audioRef.value.pause();
    audioRef.value.removeAttribute("src");
  }
}

async function playVoice(key: string, file: string): Promise<void> {
  if (playingVoiceKey.value === key) {
    stopVoicePlayback();
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

// 离开当前列表就停播：tab/子 tab/筛选/旁白开关任一变化都意味着当前行可能已不在页面上
watch([tab, assetTab, voiceChapterFilter, voiceCharFilter, showNarrationVoice], () => stopVoicePlayback());

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
  logAssetStart(`重配单句 ${key}`);
  try {
    const p = await regenerateVoiceLine(ctx, key, () => regenAbort.value);
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
  logAssetStart(`重配「${charId}」全部配音`);
  try {
    const { signal, onProgress } = regenCtl();
    const r = await regenerateCharacterVoice(ctx, charId, signal, onProgress);
    const aborted = regenAbort.value;
    pushLog({
      step: "素材",
      message: aborted
        ? `角色「${charId}」配音已中断：已重配 ${r.count} 句${r.failed ? `、失败 ${r.failed} 句` : ""}`
        : r.failed
          ? `角色「${charId}」配音：成功 ${r.count} 句、失败 ${r.failed} 句（可在「失败项」定位并补跑）`
          : `角色「${charId}」全部配音已重新生成 ${r.count} 句`,
      level: aborted || r.failed ? "warn" : "success",
      at: Date.now(),
    });
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

/** 批量重配已选语音：逐句重配，中断即停，如实汇报成功/失败 */
async function regenSelectedVoices(): Promise<void> {
  const keys = [...selectedVoice.value];
  if (!keys.length) return;
  const ctx = await regenCtx();
  if (!ctx) return;
  if (!ctx.ttsCfg) {
    pushLog({ step: "素材", message: t("配音（TTS）未启用或未配置 API，无法重配语音；请在「API 配置」页配置"), level: "warn", at: Date.now() });
    return;
  }
  if (!window.confirm(`将重配已选 ${keys.length} 句配音（TTS 计费，逐句覆盖现有文件）。继续吗？`)) return;
  assetBusy.value = `voice-batch:${keys.length}`;
  resetRegenState();
  logAssetStart(`批量重配语音（${keys.length} 句）`);
  let okCount = 0;
  let failCount = 0;
  try {
    for (const key of keys) {
      if (regenAbort.value) break;
      const p = await regenerateVoiceLine(ctx, key, () => regenAbort.value);
      if (p) okCount++;
      else failCount++;
    }
    const aborted = regenAbort.value;
    pushLog({
      step: "素材",
      message: aborted
        ? `批量重配语音已中断：成功 ${okCount} 句${failCount ? `、失败 ${failCount} 句` : ""}`
        : failCount
          ? `批量重配语音完成：成功 ${okCount} 句、失败 ${failCount} 句（可查看日志后重试）`
          : `批量重配语音完成：已重配 ${okCount} 句`,
      level: aborted || failCount ? "warn" : "success",
      at: Date.now(),
    });
    if (okCount) {
      selectedVoice.value = new Set();
      assetBusy.value = "";
      await execute({ stages: ["assemble"] });
    }
  } catch (e) {
    pushLog({ step: "素材", message: `批量重配语音失败：${errMsg(e)}`, level: "error", at: Date.now() });
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
  if (!window.confirm("将逐句核对配音并按需重配缺失/错配语音（TTS 计费），并清理不再引用的孤儿音频文件。继续吗？")) return;
  assetBusy.value = "repair-voice";
  resetRegenState();
  logAssetStart("补全缺失/错配语音：逐句核对剧本→映射→文件");
  try {
    const r = await repairVoiceAssets(ctx.ttsCfg, ctx.chapters, ctx.cards.characters, ctx.outputDir, ctx.log, 3, () => regenAbort.value);
    if (r.aborted) {
      pushLog({
        step: "素材",
        message: `补全缺失语音已中断：已检查 ${r.total} 句，已重配 ${r.fixed} 句${r.failed ? `、失败 ${r.failed} 句` : ""}${r.purged ? `，已清理孤儿文件 ${r.purged} 个` : ""}（其余未处理）`,
        level: "warn",
        at: Date.now(),
      });
    } else if (r.failed > 0) {
      pushLog({
        step: "素材",
        message: `补全缺失语音完成：检查 ${r.total} 句，重配成功 ${r.fixed} 句、失败 ${r.failed} 句${r.purged ? `，清理孤儿文件 ${r.purged} 个` : ""}；失败的句子可稍后重试`,
        level: "warn",
        at: Date.now(),
      });
    } else if (r.fixed > 0) {
      pushLog({
        step: "素材",
        message: `补全缺失语音完成：检查 ${r.total} 句，重配 ${r.fixed} 句，清理孤儿文件 ${r.purged} 个；正在重新组装…`,
        level: "success",
        at: Date.now(),
      });
    } else {
      pushLog({
        step: "素材",
        message: `配音结构健康：${r.total} 句全部与当前剧本一致，无需重配${r.purged ? `（顺手清理孤儿文件 ${r.purged} 个）` : ""}`,
        level: "success",
        at: Date.now(),
      });
    }
    if (!r.aborted && r.fixed > 0) {
      assetBusy.value = "";
      await execute({ stages: ["assemble"] });
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
  pushLog({
    step: "素材",
    message: `清理无效素材开始（${chaptersComplete ? "剧本上下文完整：剪过期映射＋迁旧 CG＋删孤儿文件＋去缺文件条目" : "剧本上下文不完整：只做文件级清理，不剪映射"}）…`,
    level: "info",
    at: Date.now(),
  });
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
    }, ctx.log, () => regenAbort.value);
    if (r.aborted) {
      pushLog({
        step: "素材",
        message: `清理已中断：已完成部分（剪枝 ${r.prunedRefs} 项，迁移旧版 CG ${r.migratedCg} 项，删除孤儿文件 ${r.purgedFiles} 个，清理缺文件映射 ${r.missingDropped} 项）；预览未刷新，可稍后点「组装」`,
        level: "warn",
        at: Date.now(),
      });
    } else {
      pushLog({
        step: "素材",
        message: `清理完成：剪枝 ${r.prunedRefs} 项，迁移旧版 CG ${r.migratedCg} 项，删除孤儿文件 ${r.purgedFiles} 个，清理缺文件映射 ${r.missingDropped} 项；正在重新组装…`,
        level: "success",
        at: Date.now(),
      });
      assetBusy.value = "";
      await execute({ stages: ["assemble"] });
    }
  } catch (e) {
    pushLog({ step: "素材", message: `清理无效素材失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    resetRegenState();
    await loadAssetMapNow(true);
  }
}

/** 从自动备份恢复 assets.json 映射（剪枝误删/映射被洗空时救命用；恢复后缺文件项用补全补回） */
async function restoreAssetBackupNow(): Promise<void> {
  const out = projectState.outputDir;
  if (!out || assetBusy.value) {
    pushLog({ step: "素材", message: "恢复映射备份未执行：无输出目录或有任务正在执行中", level: "warn", at: Date.now() });
    return;
  }
  const backups = await listAssetBackups(out);
  if (!backups.length) {
    pushLog({ step: "素材", message: "暂无映射备份（剪枝时会自动备份，最多保留 3 份）", level: "info", at: Date.now() });
    return;
  }
  const latest = backups[0];
  if (!window.confirm(`将素材映射恢复到备份 ${latest}？\n共 ${backups.length} 份备份：${backups.join("、")}\n当前映射将被覆盖。继续吗？`)) return;
  pushLog({ step: "素材", message: `从备份恢复映射开始：${latest}`, level: "info", at: Date.now() });
  // 恢复期间必须占用 assetBusy：否则并发点其它素材按钮会同时读写 assets.json（恢复读写的正是同一文件）
  assetBusy.value = "restore-map";
  try {
    await restoreAssetBackup(out, latest);
    await loadAssetMapNow(true);
    pushLog({ step: "素材", message: `映射已从 ${latest} 恢复；文件缺失项可用「补全缺失图片/补全缺失语音」补回`, level: "success", at: Date.now() });
  } catch (e) {
    pushLog({ step: "素材", message: `恢复失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
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
  if (busy.value || assetBusy.value || queueRunning.value) {
    error.value = t("有任务正在生成中，请等待完成或中止后再切换项目");
    return;
  }
  const dir = outputDirDraft.value.trim();
  if (!dir) {
    error.value = t("输出目录为空：请先填写或浏览选择一个项目目录，再点「加载该项目」");
    return;
  }
  try {
    await restoreProject(dir);
  } catch (e) {
    // 读取损坏/不可写的目录此前会变成未处理的 Promise 异常，界面毫无反馈
    const msg = errMsg(e);
    error.value = `${t("加载项目失败：")}${msg}`;
    pushLog({ step: "项目", message: `加载项目失败：${msg}`, level: "error", at: Date.now() });
    return;
  }
  error.value = "";
  configState.outputDir = dir;
  addRecentOutputDir(dir);
  upsertProject(dir);
  pushLog({ step: "项目", message: `已加载项目状态：${dir}`, level: "success", at: Date.now() });
  await stageStatus.refresh();
}

/**
 * B28：结构同步的增量清单。轮询节拍每 2s 一次，旧实现每次都把全部剧本缓存读盘 + JSON.parse，
 * 100 章规模下会持续占用主线程。现改为：文件名+大小清单未变直接跳过；只有新增/大小变化的文件
 * 才读盘解析，解析结果按文件名缓存复用（同一对象进 lastResult，不再整本反复解析驻留）。
 * 注：FsEntry 没有 mtime，用 size 近似「修改」检测（同一文件大小不变的重写无法感知，脚本缓存极少出现）。
 */
let liveShapeDir = "";
let liveShapeManifestKey = "";
const liveShapeFileSizes = new Map<string, number>();
const liveShapeScriptCache = new Map<string, ChapterScript>();

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
    // 先探盘：只有磁盘上确实有本项目的产物（卡片 / 章节缓存 / meta）时才补结构。
    // 否则全新项目会被造出一个空壳 lastResult，界面会误报「已有生成结果 / 状态=已完成」、
    // 折叠「生成内容」选项、把阶段看板显示成已完成空状态。
    const [hasCardsFile, hasDemoCardsFile, hasMeta] = await Promise.all([
      tauri.pathExists(`${outputDir}/.novel2vn/cards.json`).catch(() => false),
      tauri.pathExists(`${outputDir}/.novel2vn/cards_demo.json`).catch(() => false),
      tauri.pathExists(`${outputDir}/.novel2vn/meta.json`).catch(() => false),
    ]);
    const entries = await tauri.listDir(`${outputDir}/.novel2vn/cache`).catch(() => [] as { name: string; path: string; isDir: boolean; size: number }[]);
    const files = entries
      .filter((e) => !e.isDir && /^script(_demo)?_ch\d+_/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!hasCardsFile && !hasDemoCardsFile && !hasMeta && !files.length) return;
    // 换项目：增量清单与解析缓存都属于旧目录，直接清空
    if (liveShapeDir !== outputDir) {
      liveShapeDir = outputDir;
      liveShapeManifestKey = "";
      liveShapeFileSizes.clear();
      liveShapeScriptCache.clear();
    }
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
    if (hasCardsFile || hasDemoCardsFile) {
      // 与 pipeline / 卡片编辑同源读取（cards.json 优先，演示版落在 cards_demo.json）
      const cards = await readWorkingCards(outputDir);
      if (cards) projectState.lastResult.cards = cards;
    }
    if (!files.length) return;
    // 文件名+大小清单未变 → 无新增/修改，直接跳过：不读盘、不解析、不替换数组。
    // Tauri/web 的 listDir 都带真实 size；Node 兜底（测试/脚本）恒为 0，此时无法感知修改，
    // 退回旧的全量读盘行为，保证正确性（生产环境仍是增量）。
    const sizesKnown = files.some((f) => f.size > 0);
    const manifestKey = sizesKnown ? files.map((f) => `${f.name}:${f.size}`).join("|") : "";
    if (sizesKnown && manifestKey === liveShapeManifestKey) return;
    liveShapeManifestKey = manifestKey;
    // 只读新增/大小变化的文件；已处理过的按大小跳过（解析失败的也记录大小，避免每 2s 反复重读）
    for (const f of files) {
      if (sizesKnown && liveShapeFileSizes.get(f.name) === f.size) continue;
      liveShapeFileSizes.set(f.name, f.size);
      try {
        const { text } = await tauri.readTextFile(f.path);
        liveShapeScriptCache.set(f.name, parseChapterScript(JSON.parse(text)));
      } catch {
        liveShapeScriptCache.delete(f.name);
      }
    }
    // 已消失文件的缓存与大小记录一起清掉
    const namesNow = new Set(files.map((f) => f.name));
    for (const name of [...liveShapeScriptCache.keys()]) if (!namesNow.has(name)) liveShapeScriptCache.delete(name);
    for (const name of [...liveShapeFileSizes.keys()]) if (!namesNow.has(name)) liveShapeFileSizes.delete(name);
    // 重建章节数组：按文件名升序覆盖（同章多缓存时字典序靠后者胜，与旧实现 chapters[sc.chapter]=sc 一致）
    const byChapter = new Map<number, ChapterScript>();
    for (const f of files) {
      const sc = liveShapeScriptCache.get(f.name);
      if (sc) byChapter.set(sc.chapter, sc);
    }
    const chapters = [...byChapter.values()].sort((a, b) => a.chapter - b.chapter);
    // 全部缓存都解析失败时不清空已有章节（保留旧结构比清空安全）
    if (chapters.length || projectState.lastResult.chapters.length === 0) {
      projectState.lastResult.chapters = chapters;
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
  await loadVerifyReports();
}

/* ==================== 保真核对（剧本 vs 原文，逐条可操作） ==================== */

interface VerifyReportRow {
  chapterIndex: number;
  title: string;
  keptRatio: number;
  originalQuoteCount: number;
  dialogueCount: number;
  /** 段落覆盖率（#794）：旧报告没有该字段，属可选 */
  paragraphCount?: number;
  coveredParagraphCount?: number;
  narrationRatio?: number;
  notFoundCount: number;
  ignored: string[];
  issues: SpeakerIssue[];
}

const verifyReports = ref<VerifyReportRow[]>([]);
const showTrivialVerify = ref(false);
const verifyBusy = ref("");

function verifyReasonLabel(reason: SpeakerIssue["reason"]): string {
  switch (reason) {
    case "not-in-source": return "原文无出处（疑似新增/改写）";
    case "order-suspect": return "疑似乱序/并句";
    case "context-mismatch": return "说话人存疑";
    case "third-person-self": return "张冠李戴";
    default: return reason;
  }
}

function isTrivialVerifyIssue(issue: SpeakerIssue): boolean {
  return issue.reason === "order-suspect" && (issue.text || "").length < 6;
}

/** 卡片指纹（剧本缓存键的一部分）：与管线同源，优先用内存卡片，其次读磁盘工作副本。
 *  重新提取导致角色 id 变化时，旧剧本按指纹自动失效（否则渲染人名会退化成内部 id）。 */
async function cardsFpForScript(): Promise<string> {
  const cards = projectState.lastResult?.cards;
  if (cards?.characters?.length) return cardsFingerprint(cards);
  const dir = projectState.outputDir;
  if (!dir) return "";
  for (const f of ["cards.json", "cards_demo.json"]) {
    try {
      const { text } = await tauri.readTextFile(`${dir}/.novel2vn/${f}`);
      const parsed = JSON.parse(text) as { characters?: { id: string; name?: string }[] };
      if (Array.isArray(parsed.characters)) return cardsFingerprint(parsed);
    } catch {
      /* 换下一个 */
    }
  }
  return "";
}

async function loadVerifyReports(): Promise<void> {
  verifyReports.value = [];
  const out = projectState.outputDir;
  if (!out) return;
  try {
    const entries = await tauri.listDir(`${out}/.novel2vn/cache`);
    const rows: VerifyReportRow[] = [];
    for (const e of entries) {
      if (e.isDir || !/^script_verify(_demo)?_ch\d+_/.test(e.name)) continue;
      const rep = await readScriptVerify(e.path);
      if (!rep) continue;
      // demo/正式隔离 + 过期残留过滤（与剧本缓存同口径）
      const demoNow = !activeConfig("llm")?.apiKey;
      if (e.name.includes("script_verify_demo_") !== demoNow) continue;
      const ch0 = projectState.novel?.chapters.find((c) => c.index === rep.chapterIndex);
      if (ch0) {
        const style0 = (projectState.options.scriptStyle ?? "").trim();
        const rest0 = scriptCacheRest(
          ch0.title,
          ch0.text || "",
          scriptFingerprint({ style: style0, compressNarration: projectState.options.compressNarration, cardsFp: await cardsFpForScript() }),
        );
        if (rep.textFp !== rest0) continue;
      }
      const ch = projectState.novel?.chapters.find((c) => c.index === rep.chapterIndex);
      rows.push({
        chapterIndex: rep.chapterIndex,
        title: ch?.title ?? rep.title,
        keptRatio: rep.result.keptRatio,
        originalQuoteCount: rep.result.originalQuoteCount,
        dialogueCount: rep.result.dialogueCount,
        paragraphCount: rep.result.paragraphCount,
        coveredParagraphCount: rep.result.coveredParagraphCount,
        narrationRatio: rep.result.narrationRatio,
        notFoundCount: rep.result.notFoundCount,
        ignored: rep.ignored,
        issues: rep.result.speakerIssues,
      });
    }
    rows.sort((a, b) => a.chapterIndex - b.chapterIndex);
    verifyReports.value = rows;
  } catch {
    verifyReports.value = [];
  }
}

function visibleVerifyIssues(rep: VerifyReportRow): (SpeakerIssue & { key: string; trivial: boolean })[] {
  return rep.issues
    .map((i) => ({ ...i, key: verifyIssueKey(i.sceneIndex, i.lineIndex, i.reason), trivial: isTrivialVerifyIssue(i) }))
    .filter((i) => !rep.ignored.includes(i.key) && (showTrivialVerify.value || !i.trivial));
}

function trivialVerifyCount(rep: VerifyReportRow): number {
  return rep.issues.filter((i) => isTrivialVerifyIssue(i) && !rep.ignored.includes(verifyIssueKey(i.sceneIndex, i.lineIndex, i.reason))).length;
}

function charNameOfId(id: string): string {
  const c = projectState.lastResult?.cards.characters.find((x) => x.id === id);
  return c?.name ?? id;
}

/** 该章的「生成时源文本」：启用翻译（options.language）的项目里剧本是按译文生成的，
 *  script/verify 缓存键与保真核对都必须用译文；翻译缓存按 语言＋标题哈希＋正文哈希 命中，未命中回退原文。 */
async function sourceChapterFor(ch: { index: number; title: string; text: string }): Promise<{ index: number; title: string; text: string }> {
  const out = projectState.outputDir;
  const lang = (projectState.options.language ?? "").trim();
  if (!out || !lang) return ch;
  const path = `${out}/.novel2vn/translate/translate_${lang}_${titleHash(ch.title)}_${titleHash(ch.text)}.json`;
  try {
    const { text } = await tauri.readTextFile(path);
    const parsed = JSON.parse(text) as { title?: string; text?: string };
    if (parsed?.text) return { index: ch.index, title: parsed.title ?? ch.title, text: parsed.text };
  } catch {
    /* 该语言未命中（未翻译/译文缓存被清）：回退原文 */
  }
  return ch;
}

async function verifyScriptCacheTarget(chapterIndex: number): Promise<{ path: string; script: ChapterScript; chapter: { index: number; title: string; text: string } } | null> {
  const out = projectState.outputDir;
  const raw = projectState.novel?.chapters.find((c) => c.index === chapterIndex);
  if (!out || !raw) return null;
  // 翻译项目必须按译文定位缓存与核对（否则路径永远对不上，保真核对整页空白）
  const ch = await sourceChapterFor(raw);
  const demo = !activeConfig("llm")?.apiKey;
  const style = (projectState.options.scriptStyle ?? "").trim();
  const styleFrag = scriptFingerprint({ style, compressNarration: projectState.options.compressNarration, cardsFp: await cardsFpForScript() });
  const path = scriptCacheFileName(`${out}/.novel2vn/cache`, demo, ch.index, ch.title, ch.text || "", styleFrag);
  try {
    const { text } = await tauri.readTextFile(path);
    return { path, script: JSON.parse(text) as ChapterScript, chapter: ch };
  } catch {
    return null;
  }
}

/** 该场景配音整体作废（行号/音色变化后旧 key 全错）：删掉该场景全部配音映射，下次补配自动重配 */
async function invalidateSceneVocal(out: string, sceneId: string): Promise<number> {
  const sid = sanitizeId(sceneId);
  let dropped = 0;
  await updateAssetMap(out, (m) => {
    for (const k of Object.keys(m.vocal)) {
      const mm = /^ch\d+_(.+)_\d+$/.exec(k);
      if (mm && mm[1] === sid) {
        delete m.vocal[k];
        dropped++;
      }
    }
  });
  return dropped;
}

async function reverifyChapter(chapter: { index: number; title: string; text: string }, script: ChapterScript): Promise<void> {
  const out = projectState.outputDir;
  const chars = projectState.lastResult?.cards.characters;
  if (!out || !chars) return;
  const demo = !activeConfig("llm")?.apiKey;
  const style = (projectState.options.scriptStyle ?? "").trim();
  const styleFrag = scriptFingerprint({ style, compressNarration: projectState.options.compressNarration, cardsFp: await cardsFpForScript() });
  const cacheDir = `${out}/.novel2vn/cache`;
  const path = scriptVerifyFileName(cacheDir, demo, chapter.index, chapter.title, chapter.text || "", styleFrag);
  const prev = await readScriptVerify(path);
  const vr = verifyScriptAgainstSource(chapter.text || "", script.scenes, chars);
  await writeScriptVerify(path, {
    version: 1,
    chapterIndex: chapter.index,
    title: chapter.title,
    textFp: scriptCacheRest(chapter.title, chapter.text || "", styleFrag),
    at: new Date().toISOString(),
    result: vr,
    ignored: prev?.ignored ?? [],
  });
}

/** 接受建议说话人：免费改剧本缓存（不调 LLM），该场景配音作废待补配 */
async function acceptVerifySpeaker(rep: VerifyReportRow, issue: SpeakerIssue & { key: string }): Promise<void> {
  if (!issue.suggestedSpeakerId || verifyBusy.value) return;
  const out = projectState.outputDir;
  if (!out) return;
  verifyBusy.value = issue.key;
  try {
    const hit = await verifyScriptCacheTarget(rep.chapterIndex);
    if (!hit) {
      pushLog({ step: "剧本", message: `第 ${rep.chapterIndex + 1} 章剧本缓存不在了（可能刚重写过），请重进剧本页重试`, level: "warn", at: Date.now() });
      return;
    }
    const sceneId = hit.script.scenes[issue.sceneIndex]?.id ?? "";
    const next = applySpeakerFix(hit.script, issue.sceneIndex, issue.lineIndex, issue.suggestedSpeakerId);
    await tauri.writeTextFile(hit.path, JSON.stringify(next, null, 2));
    // 内存剧本同步：否则配音表/单句重配仍按旧说话人算（要等下一次管线运行才刷新）
    if (projectState.lastResult?.chapters) {
      projectState.lastResult.chapters = projectState.lastResult.chapters.map((c) => (c.chapter === next.chapter ? next : c));
    }
    const dropped = sceneId ? await invalidateSceneVocal(out, sceneId) : 0;
    await reverifyChapter(hit.chapter, next);
    await loadVerifyReports();
    await loadAssetMapNow(true);
    pushLog({
      step: "剧本",
      message: `第 ${rep.chapterIndex + 1} 章场景${issue.sceneIndex + 1}#${issue.lineIndex + 1}说话人已改为「${charNameOfId(issue.suggestedSpeakerId)}」（免费改缓存）${dropped ? `，该场景 ${dropped} 条配音已作废（素材页补配）` : ""}；预览需重跑「组装」`,
      level: "success",
      at: Date.now(),
    });
  } catch (e) {
    pushLog({ step: "剧本", message: `接受建议失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    verifyBusy.value = "";
  }
}

/** 删除该句：删剧本缓存对应行（需二次确认），该场景配音作废待补配 */
async function deleteVerifyLine(rep: VerifyReportRow, issue: SpeakerIssue & { key: string }): Promise<void> {
  if (verifyBusy.value) return;
  const out = projectState.outputDir;
  if (!out) return;
  if (!window.confirm(`删除第 ${rep.chapterIndex + 1} 章场景${issue.sceneIndex + 1}#${issue.lineIndex + 1}「${issue.text}」？剧本缓存立即修改（重跑剧本会还原），该场景配音作废。`)) return;
  verifyBusy.value = issue.key;
  try {
    const hit = await verifyScriptCacheTarget(rep.chapterIndex);
    if (!hit) {
      pushLog({ step: "剧本", message: `第 ${rep.chapterIndex + 1} 章剧本缓存不在了，请重进剧本页重试`, level: "warn", at: Date.now() });
      return;
    }
    const sceneId = hit.script.scenes[issue.sceneIndex]?.id ?? "";
    const next = deleteScriptLine(hit.script, issue.sceneIndex, issue.lineIndex);
    await tauri.writeTextFile(hit.path, JSON.stringify(next, null, 2));
    // 与「接受建议」同口径：内存剧本同步，配音表立即按新行号/说话人显示
    if (projectState.lastResult?.chapters) {
      projectState.lastResult.chapters = projectState.lastResult.chapters.map((c) => (c.chapter === next.chapter ? next : c));
    }
    const dropped = sceneId ? await invalidateSceneVocal(out, sceneId) : 0;
    await reverifyChapter(hit.chapter, next);
    await loadVerifyReports();
    await loadAssetMapNow(true);
    pushLog({
      step: "剧本",
      message: `已删除该句${dropped ? `，该场景 ${dropped} 条配音已作废（素材页补配）` : ""}；预览需重跑「组装」刷新`,
      level: "success",
      at: Date.now(),
    });
  } catch (e) {
    pushLog({ step: "剧本", message: `删除失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    verifyBusy.value = "";
  }
}

/** 忽略：记入忽略表（误报一批忽略），重验/重跑不丢失 */
async function ignoreVerifyIssue(rep: VerifyReportRow, issue: SpeakerIssue & { key: string }): Promise<void> {
  const out = projectState.outputDir;
  const ch = projectState.novel?.chapters.find((c) => c.index === rep.chapterIndex);
  if (!out || !ch || verifyBusy.value) return;
  verifyBusy.value = issue.key;
  try {
    const demo = !activeConfig("llm")?.apiKey;
    const style = (projectState.options.scriptStyle ?? "").trim();
    const styleFrag = scriptFingerprint({ style, compressNarration: projectState.options.compressNarration, cardsFp: await cardsFpForScript() });
    const cacheDir = `${out}/.novel2vn/cache`;
    const path = scriptVerifyFileName(cacheDir, demo, ch.index, ch.title, ch.text || "", styleFrag);
    const prev = await readScriptVerify(path);
    if (!prev) return;
    if (!prev.ignored.includes(issue.key)) prev.ignored.push(issue.key);
    await writeScriptVerify(path, prev);
    await loadVerifyReports();
    pushLog({ step: "剧本", message: `第 ${rep.chapterIndex + 1} 章场景${issue.sceneIndex + 1}#${issue.lineIndex + 1}存疑已忽略（${verifyReasonLabel(issue.reason)}）`, level: "info", at: Date.now() });
  } finally {
    verifyBusy.value = "";
  }
}

async function copyText(text: string, label: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  flashCopied(`${label}已复制`);
}

/** 统一提示条计时：多个写入点各起一个 setTimeout 会互相提前清掉彼此的消息 */
let copiedMsgTimer: number | undefined;
function flashCopied(msg: string, ms = 2000, level: "ok" | "err" = "ok"): void {
  copiedMsgLevel.value = level;
  copiedMsg.value = msg;
  if (copiedMsgTimer !== undefined) window.clearTimeout(copiedMsgTimer);
  copiedMsgTimer = window.setTimeout(() => {
    copiedMsg.value = "";
    copiedMsgTimer = undefined;
  }, ms);
}

async function copyLogs(): Promise<void> {
  const text = projectState.logs
    .map((l) => `[${new Date(l.at).toLocaleTimeString()}] [${l.step}] ${l.message}`)
    .join("\n");
  await navigator.clipboard.writeText(text);
  flashCopied(t("日志已复制"));
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
    flashCopied(`日志已保存：${path}`, 3000);
  } catch (e) {
    flashCopied(`保存失败：${errMsg(e)}`, 3000, "err");
  }
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
    flashCopied(t("已定位失败章节并切到「整书生成」：点开始即可只重试失败项（其余自动复用缓存）"), 4000);
    pushLog({ step: "失败项", message: `定位重试：失败剧本章节→第 ${Array.from(chapterIds).map((n) => n + 1).join("、")} 章已勾选（其余复用缓存）`, level: "info", at: Date.now() });
  } else {
    // 图片/翻译类失败没有章节映射：清掉可能残留的旧章节范围，否则点开始只会跑旧范围、漏掉真正的失败项
    rerunChapters.value = null;
    flashCopied(t("失败项无章节映射：已重置为全书范围并切到「整书生成」；点开始会复用缓存只补缺失/失败项（若开着「跳过缓存」会全量计费，请先确认已关闭）"), 5000);
    pushLog({ step: "失败项", message: "定位重试：失败为图片/翻译类，无章节映射，已重置章节范围（避免沿用旧勾选漏跑）；请到整书生成点开始——复用缓存只补缺失/失败项（开着「跳过缓存」时除外）", level: "warn", at: Date.now() });
  }
  // 直接带路：此前只弹 4 秒提示，用户还得自己找路切模式
  goFullMode();
  tab.value = "run";
}

/** 失败项逐条重试：只重跑该条失败对应的最小单元（单张图像/单句配音/单章剧本），不动其余内容 */
async function retryFailedTask(f: FailedTask): Promise<void> {
  if (busy.value || assetBusy.value || queueRunning.value) {
    pushLog({ step: "失败项", message: "已有任务在运行，无法逐条重试：请等待完成（或先点停止）后再试", level: "warn", at: Date.now() });
    return;
  }
  if (f.kind === "script" && f.id.startsWith("chapter_")) {
    const idx = parseInt(f.id.replace("chapter_", ""), 10) - 1;
    if (!Number.isFinite(idx) || idx < 0) return;
    await runChapterPartRegen(idx, "script");
    // 以 failed.json 为准刷新（重跑成功的章节立即从失败列表消失）
    void refreshFailedTasks();
    return;
  }
  if (f.kind === "tts") {
    const ctx = await regenCtx();
    if (!ctx) return;
    if (!ctx.ttsCfg) {
      pushLog({ step: "素材", message: t("配音（TTS）未启用或未配置 API，无法重试该句配音"), level: "warn", at: Date.now() });
      return;
    }
    const key = f.id.startsWith("vocal_") ? f.id.slice("vocal_".length) : f.id;
    if (!window.confirm(`重试该句配音（TTS 计费）？\n${f.message.slice(0, 80)}`)) return;
    assetBusy.value = `voice:${key}`;
    resetRegenState();
    try {
      const p = await regenerateVoiceLine(ctx, key, () => regenAbort.value);
      pushLog({ step: "素材", message: p ? `配音重试成功：${key}` : `配音重试失败：${key}（可稍后再试）`, level: p ? "success" : "warn", at: Date.now() });
      if (p) {
        // 重试成功必须销账：内存列表 + 项目状态 + failed.json 三处同步，否则徽标不清零、重启后失败项复活
        const sameTask = (x: FailedTask): boolean => x.id === f.id && x.kind === f.kind && x.step === f.step && x.message === f.message;
        lastRunFailedTasks.value = lastRunFailedTasks.value.filter((x) => !sameTask(x));
        const persisted = projectState.lastResult?.failedTasks;
        if (persisted) projectState.lastResult!.failedTasks = persisted.filter((x) => !sameTask(x));
        if (projectState.outputDir) {
          void mutateFailedTasks(projectState.outputDir, (prev) => prev.filter((x) => !sameTask(x))).catch(() => undefined);
        }
        scheduleSave();
        assetBusy.value = "";
        await execute({ stages: ["assemble"] });
      }
    } catch (e) {
      pushLog({ step: "素材", message: `配音重试失败：${errMsg(e)}`, level: "error", at: Date.now() });
    } finally {
      assetBusy.value = "";
      resetRegenState();
      await loadAssetMapNow(true);
      void refreshFailedTasks();
    }
    return;
  }
  if (f.kind === "image") {
    const ctx = await regenImageCtx();
    if (!ctx) return;
    if (!window.confirm(`重试该图像任务（图像 API 计费）？\n${f.message.slice(0, 80)}`)) return;
    assetBusy.value = `retry:${f.id}`;
    resetRegenState();
    try {
      const { signal, onProgress } = regenCtl();
      // bg 与 cg 共用 scene.id：必须同时按「用途前缀」匹配，否则重试失败的背景会连 CG 一起重画（双花+覆盖）
      const usagePrefix = f.message.split("：")[0]?.trim() ?? "";
      const stats: RegenBatchStats = { failed: 0, aborted: false, failedTasks: [] };
      const results = await regenerateImages(
        ctx,
        (t) => t.id === f.id && (!usagePrefix || (t.usage ?? t.fileName) === usagePrefix),
        undefined,
        signal,
        onProgress,
        stats,
      );
      await afterAssetRegen("失败项重试", results.length, stats);
      if (results.length && stats.failed === 0) {
        // 重试成功：按「id+kind+step+message（含用途前缀）」精确销账——
        // 只按 id 会连带删掉同 scene.id 的另一条用途失败（bg/cg 同名）；同时同步 failed.json
        const sameTask = (x: FailedTask): boolean => x.id === f.id && x.kind === f.kind && x.step === f.step && x.message === f.message;
        lastRunFailedTasks.value = lastRunFailedTasks.value.filter((x) => !sameTask(x));
        const persisted = projectState.lastResult?.failedTasks;
        if (persisted) projectState.lastResult!.failedTasks = persisted.filter((x) => !sameTask(x));
        if (projectState.outputDir) {
          void mutateFailedTasks(projectState.outputDir, (prev) => prev.filter((x) => !sameTask(x))).catch(() => undefined);
        }
        scheduleSave();
      }
    } catch (e) {
      pushLog({ step: "素材", message: `图像任务重试失败：${errMsg(e)}`, level: "error", at: Date.now() });
    } finally {
      assetBusy.value = "";
      resetRegenState();
      await loadAssetMapNow(true);
      void refreshFailedTasks();
    }
    return;
  }
  // 翻译/提取等无最小重跑单元的失败：沿用原「定位重试」（切到整书生成并重置范围）
  await retryFailed();
}

const rerunChapters = ref<number[] | null>(null);

// 切换项目/输出目录时清空一切与旧项目绑定的选择与意见：否则旧项目的勾选/意见框内容
// 会被带到新项目上（选择集/意见是全局 ref，重启项目后仍然保留）
watch(
  () => projectState.outputDir,
  () => {
    selected.value = new Set();
    selectedVoice.value = new Set();
    assetFeedback.value = { figure: "", item: "", bg: "", cg: "" };
    scriptChapterFeedback.value = {};
    chapterForce.value = {};
    rerunChapters.value = null;
    // 阶段意见/全量开关/待批准续跑计划/分章意见同样与旧项目绑定：
    // 不清会把 A 项目的续跑计划与全量重跑范围带到 B 项目上（静默按错误范围付费重跑）
    stageFeedback.value = {};
    stageForce.value = {};
    splitOpinion.value = "";
    clearPendingResume();
  },
);

function toggleAllRerun(on: boolean): void {
  if (!projectState.novel) return;
  rerunChapters.value = on ? null : [];
  pushLog({
    step: "整书",
    message: on ? "分章节选择：已全选（全部章节参与）" : "分章节选择：已全不选（未勾选章节复用缓存/跳过）",
    level: "info",
    at: Date.now(),
  });
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
  const ch = projectState.novel?.chapters.find((c) => c.index === index);
  const count = rerunChapters.value?.length ?? projectState.novel?.chapters.length ?? 0;
  pushLog({
    step: "整书",
    message: `分章节选择：第 ${index + 1} 章「${ch?.title ?? ""}」${checked ? "已勾选" : "已取消"}（当前共选 ${count} 章；未勾选章节复用缓存/跳过）`,
    level: "info",
    at: Date.now(),
  });
}

function stop(): void {
  error.value = "";
  const pipelineRunning = !!pipelineRef.value;
  if (!pipelineRunning && !busy.value && !assetBusy.value && !queueRunning.value) {
    // 静默无反应最糟：没在跑就明说，用户不用反复点
    stopping.value = false;
    pushLog({ step: "中止", message: "当前没有正在运行的生成任务（停止按钮只在有任务时生效）", level: "info", at: Date.now() });
    return;
  }
  pipelineRef.value?.abort();
  // 素材批量重生成走的是另一套信号（regenAbort），一起掐掉，避免「点了停止图还在出」
  regenAbort.value = true;
  queueRunning.value = false;
  stopping.value = true;
  // B27：记录停止请求，由「在途任务归零」的 watch 统一复位 stopping 并输出「已停止」日志
  pendingStop = true;
  pushLog({ step: "中止", message: t("用户请求中止，当前任务完成后将停止"), level: "warn", at: Date.now() });
  // 说清「停止」的确切语义：协作式中止，不是把已发出的 HTTP 请求掐断
  pushLog({
    step: "中止",
    message: "停止 = 不再派发新任务：已发送中的请求会跑完当前这一张再停，之后不再发起新的图片/参考图描述/文字/配音请求；已生成的内容一律保留。",
    level: "info",
    at: Date.now(),
  });
}
// 暴露给 App.vue 侧栏的停止入口（经 runStatus 轻量模块，避免外层引入整个 store）
registerRunStop(() => stop());

function onCardsSaved(cards: unknown): void {
  if (projectState.lastResult) {
    projectState.lastResult.cards = cards as never;
  }
  scheduleSave();
  // B29：卡片（角色/物品数量与 id）直接决定图像/配音任务口径与章节灯，保存后必须刷新，
  // 否则卡片页改了角色，看板与章节盘仍按旧卡片显示完成/缺失。
  void stageStatus.refresh();
  void chapterStatus.refresh();
}

function fileExistsLabel(file: string | undefined): string {
  return file ? t("已生成") : t("未生成");
}

/** 全部状态与行为（供页面 / 区块组件解构使用；解构后模板自动解包 ref） */
export const generateStore = {
  tab,
  RUN_MODE_KEY,
  STAGE_LABELS,
  initialRunMode,
  runMode,
  runModeHint,
  goFullMode,
  error,
  busy,
  pendingResumeStages,
  pendingResumeScope,
  clearPendingResume,
  pipelineRef,
  lastRunFailedTasks,
  scriptFiles,
  currentScript,
  videoStatus,
  videoInput,
  videoImportTarget,
  copiedMsg,
  copiedMsgLevel,
  logPanelRef,
  LOG_RENDER_LIMIT,
  visibleLogs,
  PIPELINE_STEPS,
  pipelineSteps,
  currentStep,
  failedSteps,
  liveProgress,
  activeRunLabels,
  clearRunLabels,
  activeStepIndexes,
  livePct,
  costText,
  failedTasks,
  failedTaskSummary,
  videoPoints,
  selectedStages,
  stageFeedback,
  stageForce,
  outputDirDraft,
  stageStatus,
  failedCounts,
  chapterStatus,
  enabledNovelChapters,
  disabledNovelChapters,
  toggleNovelChapter,
  splitMeta,
  loadSplitMeta,
  splitMetaText,
  splitOpinion,
  splitConfirmed,
  splitConfirmKey,
  loadSplitConfirmed,
  previewSplit,
  confirmSplit,
  queueRunning,
  stopping,
  selectedChapters,
  chapterIncludeVoice,
  chapterHasCards,
  toggleChapterSelected,
  selectIncompleteChapters,
  clearChapterSelection,
  runSelectedChapters,
  prepareChapterCards,
  runChapterBatch,
  runChapterQueue,
  stopChapterQueue,
  logFailedStages,
  runningStages,
  styleRefSrc,
  styleRecognizing,
  cancelStyleRecognize,
  styleRefInput,
  fileToBase64,
  pickStyleRef,
  onStyleRefFile,
  recognizeStyleAndApply,
  selectedStagesList,
  visualBibleReviewNeeded,
  autoCascadeDownstream,
  CASCADE_TRIGGERS,
  scriptChapterFeedback,
  chapterForce,
  assetMap,
  assetTab,
  assetBusy,
  assetFeedback,
  voiceChapterFilter,
  voiceCharFilter,
  preview,
  regenAbort,
  regenProgress,
  openPreview,
  regenCtl,
  resetRegenState,
  regenPct,
  selected,
  selectedCount,
  toggleSelect,
  clearSelected,
  selectAllInTab,
  selectedVoice,
  selectedVoiceCount,
  toggleVoiceSelected,
  selectAllVoice,
  clearVoiceSelected,
  regenSelectedVoices,
  regenSelected,
  regenMissingImages,
  FIGURE_EMOTIONS,
  EMOTION_LABELS,
  reCutout,
  loadAssetDataUrl,
  mimeOf,
  loadAssetMapNow,
  diffAssetPaths,
  assetLiveTimer,
  assetLiveFingerprint,
  startAssetLiveRefresh,
  stopAssetLiveRefresh,
  figureRows,
  itemRows,
  bgRows,
  cgRows,
  charNameOf,
  voiceRows,
  voiceChapterOptions,
  voiceChapterMismatch,
  failedVocalKeys,
  voiceCharOptions,
  voiceLimit,
  voiceRowsShown,
  showNarrationVoice,
  ttsReady,
  execute,
  persistRunLog,
  start,
  stageHint,
  prepareVisualBible,
  resumeAfterVisualApproval,
  onVisualBibleChanged,
  runStageRegen,
  runChapterFullRegen,
  runChapterPartRegen,
  confirmStageOpinion,
  appendInput,
  pickAppendFile,
  onAppendFile,
  runAppend,
  syncAppendedCharactersToBible,
  regenChapter,
  regenCtx,
  afterAssetRegen,
  logAssetStart,
  regenFigureEmotion,
  regenAllFigure,
  regenThreeView,
  regenAction,
  regenCostume,
  regenItem,
  regenBg,
  regenCgRow,
  audioRef,
  playingVoiceKey,
  playVoice,
  regenVoice,
  regenCharVoice,
  regenMissingVoices,
  cleanupInvalidAssets,
  restoreAssetBackupNow,
  browseOutputDir,
  loadProjectState,
  ensureLiveResultShape,
  lastShapeSyncAt,
  syncLiveResultShape,
  checkVideos,
  importVideo,
  onVideoImportFile,
  loadScripts,
  imagePlanSummary,
  imagePlanText,
  verifyReports,
  showTrivialVerify,
  verifyBusy,
  verifyReasonLabel,
  isTrivialVerifyIssue,
  loadVerifyReports,
  visibleVerifyIssues,
  trivialVerifyCount,
  charNameOfId,
  verifyScriptCacheTarget,
  invalidateSceneVocal,
  reverifyChapter,
  acceptVerifySpeaker,
  deleteVerifyLine,
  ignoreVerifyIssue,
  copyText,
  copyLogs,
  saveLogs,
  retryFailed,
  retryFailedTask,
  rerunChapters,
  toggleAllRerun,
  toggleChapterRerun,
  stop,
  onCardsSaved,
  fileExistsLabel,
};

export type GenerateStore = typeof generateStore;

export function useGenerateController(): GenerateStore {
  return generateStore;
}
