<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { t } from "../i18n";
import { open } from "@tauri-apps/plugin-dialog";
import { projectState, pushLog, clearLogs, scheduleSave, restoreProject } from "../stores/project";
import { activeConfig, configState, addRecentOutputDir } from "../stores/config";
import { Pipeline } from "../core/pipeline";
import { resolveTemplateDir } from "../utils/template";
import { tauri, isTauri } from "../utils/tauri";
import { sanitizeId } from "../core/render";
import { errMsg } from "../utils/errors";
import { log as logger, dumpLogHistory } from "../utils/logger";
import EditCards from "../components/EditCards.vue";
import StepIndicator from "../components/StepIndicator.vue";
import type { AssetMap, FailedTask, ImageTask, PipelineEvent, StageFeedback, StageKey, VideoSuggestion } from "../core/types";
import { STAGE_LABELS, STAGE_ORDER, LANGUAGES } from "../core/types";
import {
  regenerateCharacterFigures,
  regenerateCharacterThreeView,
  imageTaskMatchesSelectionKey,
  regenerateCharacterAction,
  regenerateItemImage,
  regenerateBackground,
  regenerateCg,
  regenerateVoiceLine,
  regenerateCharacterVoice,
  regenerateImages,
  type RegenContext,
} from "../core/regenerate";
import { recognizeStyle } from "../core/recognize";
import { configIsUsable } from "../api/providers";
import { useAssetThumbs, ensureAssetLoaded } from "../composables/useAssetThumbs";
import LazyThumb from "../components/LazyThumb.vue";
import AssetPreview from "../components/AssetPreview.vue";
import VisualBiblePanel from "../components/VisualBiblePanel.vue";
import {
  imageRunPreparationStages,
  resumeStagesAfterVisualApproval,
  visualBibleNeedsReview,
} from "../core/visualBibleWorkflow";

const tab = ref<"run" | "cards" | "video" | "script" | "log" | "failed" | "asset" | "bible">("run");
const error = ref("");
const busy = ref(false);
const pendingResumeStages = ref<StageKey[]>([]);
const pipelineRef = ref<Pipeline | null>(null);
const scriptFiles = ref<{ name: string; text: string }[]>([]);
const currentScript = ref("");
const videoStatus = ref<Record<string, boolean>>({});
const copiedMsg = ref("");
const logPanelRef = ref<HTMLElement | null>(null);

const PIPELINE_STEPS = ["翻译", "提取", "剧本", "图像", "配音", "组装"];
const pipelineSteps = computed(() => PIPELINE_STEPS.map((s) => t(s)));
const currentStep = ref(-1);
const failedSteps = ref<number[]>([]);

// 实时进度：最近一条带 progress 的管线事件（图片 12/45 · 当前任务）
const liveProgress = ref<{ step: string; done: number; total: number; label: string } | null>(null);

watch(
  () => projectState.logs.length,
  async () => {
    const last = projectState.logs[projectState.logs.length - 1];
    if (last) {
      const idx = PIPELINE_STEPS.indexOf(last.step);
      if (idx >= 0 && last.level !== "error") currentStep.value = Math.max(currentStep.value, idx);
      if (last.level === "error" && idx >= 0 && !failedSteps.value.includes(idx)) failedSteps.value.push(idx);
      if (last.progress) liveProgress.value = { step: last.step, ...last.progress };
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
    llm: `${c.llmTokens.toLocaleString()} tokens · ¥${c.llmCostYuan.toFixed(3)}`,
    image: `${c.imageCount} 张 · ¥${c.imageCostYuan.toFixed(2)}`,
    tts: `${c.ttsChars.toLocaleString()} 字符 · ¥${c.ttsCostYuan.toFixed(3)}`,
    total: (c.llmCostYuan + c.imageCostYuan + c.ttsCostYuan).toFixed(2),
  };
});

const failedTasks = computed<FailedTask[]>(() => projectState.lastResult?.failedTasks ?? []);

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

function regenCtl(): { signal: { aborted: () => boolean }; onProgress: (done: number, total: number, label: string) => void } {
  return {
    signal: { aborted: () => regenAbort.value },
    onProgress: (done, total, label) => {
      regenProgress.value = { done, total, label };
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
  }
}

const FIGURE_EMOTIONS = ["normal", "happy", "sad", "angry", "surprised"];
const EMOTION_LABELS: Record<string, string> = { normal: t("默认"), happy: t("开心"), sad: t("悲伤"), angry: t("愤怒"), surprised: t("惊讶") };

// 素材预览/试听：读成 base64 data-URL（桌面/网页通用），失败不重试、并发受限，避免卡死
const { loadAssetDataUrl, mimeOf } = useAssetThumbs();

async function loadAssetMapNow(): Promise<void> {
  try {
    if (!projectState.outputDir) {
      assetMap.value = null;
      return;
    }
    const { text } = await tauri.readTextFile(`${projectState.outputDir}/.novel2vn/assets.json`);
    assetMap.value = JSON.parse(text) as AssetMap;
  } catch {
    assetMap.value = null;
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
      .map((s) => ({ chapter: ch.chapter + 1, sceneId: s.id, title: s.cgEvent!.title, file: assetMap.value!.cg[`${ch.chapter}_${s.id}`] })),
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
        if (line.type !== "dialogue") return null;
        const key = `ch${ch.chapter}_${sanitizeId(s.id)}_${i}`;
        return { key, chapter: ch.chapter + 1, scene: s.location, charId: line.characterId, text: line.text, file: assetMap.value!.vocal[key] };
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
  return r.chapters.map((c) => ({ value: c.chapter + 1, label: `第 ${c.chapter + 1} 章 ${c.title}` }));
});

const voiceCharOptions = computed(() => {
  const r = projectState.lastResult;
  if (!r) return [];
  return r.cards.characters.map((c) => ({ value: c.id, label: c.name }));
});

const voiceLimit = ref(100);
const voiceRowsShown = computed(() => voiceRows.value.slice(0, voiceLimit.value));

/* ==================== 执行管线（分阶段） ==================== */

interface ExecuteOptions {
  stages: StageKey[];
  feedback?: StageFeedback;
  forceStages?: StageKey[];
  clearLogsFirst?: boolean;
  rerunChapters?: number[] | null;
}

async function execute(opts: ExecuteOptions): Promise<boolean> {
  error.value = "";
  const novel = projectState.novel;
  if (!novel) {
    error.value = t("请先在「导入小说」页导入小说（或加载示例小说）");
    return false;
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
  if (opts.clearLogsFirst) {
    clearLogs();
    currentStep.value = -1;
    failedSteps.value = [];
  }
  busy.value = true;
  projectState.running = true;
  const log = (ev: PipelineEvent) => pushLog(ev);
  try {
    const templateDir = await resolveTemplateDir();
    const pipeline = new Pipeline({
      novel,
      materials: projectState.materials,
      llm: llm?.apiKey ? llm : undefined,
      vision: configIsUsable(vision, "vision") ? vision : undefined,
      image: projectState.options.useImage && image?.apiKey ? image : undefined,
      tts: projectState.options.useTts && tts?.apiKey ? tts : undefined,
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
      log,
    });
    pipelineRef.value = pipeline;

    log({
      step: "开始",
      message: `管线启动（阶段：${opts.stages.map((s) => STAGE_LABELS[s]).join(" → ")}）`,
      level: "info",
      at: Date.now(),
    });
    const result = await pipeline.run();
    projectState.lastResult = result;
    addRecentOutputDir(result.meta.outputDir);
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
      await loadAssetMapNow();
    }
    if (opts.clearLogsFirst) tab.value = "cards";
    log({ step: "完成", message: `全部完成！项目输出到 ${result.meta.outputDir}，可前往「预览」页试玩`, level: "success", at: Date.now() });
    return true;
  } catch (e) {
    const msg = errMsg(e);
    logger.error("page", "生成失败", { message: msg });
    if (msg === "已中止") {
      logger.warn("page", "生成被用户中止");
      log({ step: "中止", message: t("已停止生成，进度已保存（缓存命中部分不会重复计费）"), level: "warn", at: Date.now() });
    } else {
      error.value = msg;
      log({ step: "错误", message: msg, level: "error", at: Date.now() });
    }
    return false;
  } finally {
    busy.value = false;
    projectState.running = false;
    pipelineRef.value = null;
  }
}

function start(): void {
  void execute({ stages: selectedStagesList.value, clearLogsFirst: true });
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
    await loadAssetMapNow();
  }
}

function onVisualBibleChanged(): void {
  void loadAssetMapNow();
}

/* ==================== 分阶段操作 ==================== */

function runSplitRegen(): void {
  const fb = stageFeedback.value.split?.trim() || "";
  void execute({
    stages: ["split", "extract", "script", "image", "assemble"],
    feedback: fb ? { split: fb } : undefined,
    forceStages: ["split"],
    rerunChapters: null,
  }).then(() => {
    stageFeedback.value.split = "";
    void loadAssetMapNow();
  });
}

function runExtractRegen(): void {
  const fb = stageFeedback.value.extract?.trim() || "";
  void execute({
    stages: ["extract", "script", "image", "assemble"],
    feedback: fb ? { extract: fb } : undefined,
    forceStages: ["extract"],
    rerunChapters: null,
  }).then(() => {
    stageFeedback.value.extract = "";
    void loadAssetMapNow();
  });
}

function runScriptRegen(): void {
  const fb = stageFeedback.value.script?.trim() || "";
  const fbMap: Record<number, string> = {};
  if (fb) for (const c of projectState.novel?.chapters ?? []) fbMap[c.index] = fb;
  void execute({
    stages: ["script", "assemble"],
    feedback: fb ? { script: fbMap } : undefined,
    forceStages: ["script"],
    rerunChapters: null,
  }).then(() => {
    stageFeedback.value.script = "";
  });
}

function runImageRegen(): void {
  const fb = stageFeedback.value.image?.trim() || "";
  void execute({
    stages: ["image", "assemble"],
    feedback: fb ? { image: fb } : undefined,
    forceStages: ["image"],
  }).then(() => {
    stageFeedback.value.image = "";
    void loadAssetMapNow();
  });
}

function runVoiceRegen(): void {
  void execute({ stages: ["voice", "assemble"], forceStages: ["voice"] }).then(() => void loadAssetMapNow());
}

function runAssemble(): void {
  void execute({ stages: ["assemble"] });
}

function runTranslateRegen(): void {
  const fb = stageFeedback.value.translate?.trim() || "";
  void execute({
    stages: ["translate", "extract", "script", "image", "assemble"],
    feedback: fb ? { translate: fb } : undefined,
    forceStages: ["translate"],
    rerunChapters: null,
  }).then(() => {
    stageFeedback.value.translate = "";
  });
}

function regenChapter(idx: number): void {
  const fb = scriptChapterFeedback.value[idx]?.trim() ?? "";
  void execute({
    stages: ["script", "assemble"],
    feedback: { script: { [idx]: fb } },
    rerunChapters: null,
  }).then(() => {
    scriptChapterFeedback.value[idx] = "";
    void loadScripts();
  });
}

/* ==================== 素材 Tab 操作 ==================== */

async function regenCtx(): Promise<RegenContext | null> {
  const r = projectState.lastResult;
  if (!r) return null;
  const imageCfg = activeConfig("image");
  const ttsCfg = activeConfig("tts");
  const visionCfg = activeConfig("vision");
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
    ttsCfg: projectState.options.useTts && ttsCfg?.apiKey ? ttsCfg : undefined,
    chapters: r.chapters,
    cards: r.cards,
    materials: projectState.materials,
    outputDir: projectState.outputDir,
    log: (ev) => pushLog(ev),
    style: projectState.options.imageStyle || undefined,
    figureEmotions: projectState.options.figureEmotions,
    threeView: projectState.options.characterPoses !== false,
    actions: projectState.options.characterPoses !== false,
    verifyCfg: projectState.options.imageSelfCheck ? visionCfg : undefined,
    visionCfg: configIsUsable(visionCfg, "vision") ? visionCfg : undefined,
    imageSeed: projectState.options.imageSeed || undefined,
    concurrency: projectState.options.maxConcurrent,
    styleAnchor: projectState.options.styleAnchor,
    visualBible: projectState.visualBible?.status === "approved" ? projectState.visualBible : undefined,
  };
}

async function afterAssetRegen(label: string, resultsLength: number): Promise<void> {
  pushLog({ step: "素材", message: `${label}：已重新生成 ${resultsLength} 项，正在重新组装…`, level: "success", at: Date.now() });
  await execute({ stages: ["assemble"] });
  await loadAssetMapNow();
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
    await execute({ stages: ["assemble"] });
  } catch (e) {
    pushLog({ step: "素材", message: `重新配音失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    resetRegenState();
    await loadAssetMapNow();
  }
}

async function regenCharVoice(charId: string): Promise<void> {
  const ctx = await regenCtx();
  if (!ctx) return;
  assetBusy.value = `voice-all:${charId}`;
  resetRegenState();
  try {
    const { signal, onProgress } = regenCtl();
    const n = await regenerateCharacterVoice(ctx, charId, signal, onProgress);
    pushLog({ step: "素材", message: `角色「${charId}」全部配音已重新生成 ${n} 句`, level: "success", at: Date.now() });
    await execute({ stages: ["assemble"] });
  } catch (e) {
    pushLog({ step: "素材", message: `重新配音失败：${errMsg(e)}`, level: "error", at: Date.now() });
  } finally {
    assetBusy.value = "";
    resetRegenState();
    await loadAssetMapNow();
  }
}

/* ==================== 原有功能 ==================== */

async function browseOutputDir(): Promise<void> {
  if (!isTauri()) {
    projectState.outputDir = await tauri.getDefaultOutputDir();
    configState.outputDir = projectState.outputDir;
    pushLog({ step: "项目", message: t("Web 版输出目录固定为虚拟目录 /app/exports"), level: "info", at: Date.now() });
    return;
  }
  const dir = await open({ directory: true, multiple: false });
  if (dir && typeof dir === "string") {
    projectState.outputDir = dir;
    configState.outputDir = dir;
  }
}

async function loadProjectState(): Promise<void> {
  if (!projectState.outputDir) return;
  await restoreProject(projectState.outputDir);
  addRecentOutputDir(projectState.outputDir);
  pushLog({ step: "项目", message: `已加载项目状态：${projectState.outputDir}`, level: "success", at: Date.now() });
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
    copiedMsg.value = t("已定位失败章节，点击「开始生成」重试（其余章节复用缓存）");
  } else {
    copiedMsg.value = t("无章节级失败；请勾选「跳过缓存」后重跑以重试图像任务");
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
    <div class="page-head">
      <div>
        <div class="page-title">{{ t("生成项目") }}</div>
        <p class="page-sub">{{ t("AI 管线：提取 → 剧本 → 图像 → 配音 → 组装。可整体跑，也可分阶段单独执行与重生成。") }}</p>
      </div>
      <div class="page-actions">
        <button class="btn" :disabled="busy" @click="start">
          <span v-if="busy" class="spinner" />
          {{ busy ? t("生成中…") : t("开始生成") }}
        </button>
        <button v-if="busy" class="btn danger" @click="stop">{{ t("停止") }}</button>
      </div>
    </div>

    <div v-if="visualBibleReviewNeeded" class="vb-banner">
      <div>
        <strong>{{ t("图像生成前需要确认视觉圣经") }}</strong>
        <p>{{ t("统一风格与角色三视图尚未批准，图像阶段会先停在这里。") }}</p>
      </div>
      <button class="btn secondary small" @click="tab = 'bible'">{{ t("去确认") }}</button>
    </div>

    <div v-if="busy || currentStep >= 0" style="margin-bottom: var(--space-4)">
      <StepIndicator :steps="pipelineSteps" :current="currentStep" :failed="failedSteps" />
    </div>

    <div class="card" style="padding: var(--space-4)">
      <div style="display: flex; flex-wrap: wrap; gap: var(--space-3)">
        <label class="field" style="flex: 2 1 340px; margin-bottom: 0">
          <span>{{ t("输出目录") }}</span>
          <div class="row">
            <input type="text" v-model="projectState.outputDir" style="flex: 3" />
            <button class="btn secondary small" @click="browseOutputDir">{{ t("浏览…") }}</button>
            <button class="btn ghost small" @click="loadProjectState">{{ t("加载该项目") }}</button>
          </div>
        </label>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(430px, 1fr)); gap: var(--space-4)">
      <div class="card" style="margin-bottom: 0">
        <div class="card-head"><h3>{{ t("生成内容") }}</h3></div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px 18px">
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px">
            <input type="checkbox" v-model="projectState.options.useImage" /> {{ t("图像（立绘/背景/CG/物品）") }}
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px">
            <input type="checkbox" v-model="projectState.options.figureEmotions" /> {{ t("表情差分（5 表情/角色）") }}
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px">
            <input type="checkbox" v-model="projectState.options.figureActions" /> {{ t("人物动作（入场/情绪动作/镜头震动）") }}
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px">
            <input type="checkbox" v-model="projectState.options.characterPoses" /> {{ t("角色三视图与动作立绘（图生图，形象更一致）") }}
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px" :title="t('先生成一张全项目画风基准图，背景/CG 以其为参考图，强制所有图片画风统一（推荐开启）')">
            <input type="checkbox" v-model="projectState.options.styleAnchor" /> {{ t("风格锚点（背景/CG 统一画风）") }}
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px" :title="t('使用独立图片识别 API 核对生成图，不合格自动重生成 1 次（会增加费用与耗时）')">
            <input type="checkbox" v-model="projectState.options.imageSelfCheck" /> {{ t("图像自检（多模态核对，不合格自动重生成）") }}
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px">
            <input type="checkbox" v-model="projectState.options.useTts" /> {{ t("配音（TTS）") }}
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px">
            <input type="checkbox" v-model="projectState.options.useVideoPoints" /> {{ t("视频推荐位") }}
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px">
            <input type="checkbox" v-model="projectState.options.useBgm" /> {{ t("BGM 匹配") }}
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px">
            <input type="checkbox" v-model="projectState.options.characterIntroCard" /> {{ t("角色登场资料卡") }}
          </label>
        </div>
        <label class="field" style="margin-top: 12px">
          <span>{{ t("目标语言（先把小说翻译成该语言再生成，留空 = 用原文）") }}</span>
          <select v-model="projectState.options.language">
            <option value="">{{ t("不翻译（使用原文）") }}</option>
            <option v-for="l in LANGUAGES" :key="l.code" :value="l.code">{{ l.label }}</option>
          </select>
        </label>
        <label class="field" style="margin-top: 12px">
          <span>{{ t("统一画风（留空用默认画风，所有立绘/背景/CG 保持一致）") }}</span>
          <input
            type="text"
            v-model="projectState.options.imageStyle"
            :placeholder="t('例：unified Japanese anime style, cel shading, clean line art')"
          />
        </label>
        <div class="row" style="align-items: flex-end; margin-top: 10px">
          <div class="field" style="flex: 1; margin-bottom: 0">
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
          </div>
          <img
            v-if="styleRefSrc"
            :src="styleRefSrc"
            :alt="t('风格参考图')"
            style="width: 72px; height: 72px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border)"
          />
        </div>
        <label class="field" style="margin-top: 12px">
          <span>{{ t("剧本风格（按此风格重写台词与旁白，留空不调整。例：古风典雅 / 幽默风趣 / 冷峻克制）") }}</span>
          <input type="text" v-model="projectState.options.scriptStyle" :placeholder="t('例：古风典雅，多用对仗与典雅意象')" />
        </label>
      </div>

      <div class="card" style="margin-bottom: 0">
        <div class="card-head"><h3>{{ t("预算与范围") }}</h3></div>
        <div class="row">
          <label class="field">
            <span>{{ t("每章 CG 数上限") }}</span>
            <input type="number" v-model.number="projectState.options.cgPerChapter" min="0" max="10" />
          </label>
          <label class="field">
            <span>{{ t("每章图像数上限") }}</span>
            <input type="number" v-model.number="projectState.options.imageBudgetPerChapter" min="0" max="50" />
          </label>
          <label class="field">
            <span>{{ t("视频推荐点数上限") }}</span>
            <input type="number" v-model.number="projectState.options.videoPointsPerChapter" min="0" max="5" />
          </label>
        </div>
        <div class="row">
          <label class="field">
            <span>{{ t("预算上限（¥，0 = 不限）") }}</span>
            <input type="number" v-model.number="projectState.options.budgetYuan" min="0" step="0.5" />
          </label>
          <label class="field" :title="t('同时生成图片/配音的任务数。调大可显著提速，但会同时消耗多张额度；建议 2-6')">
            <span>{{ t("图像/配音并发数") }}</span>
            <input type="number" v-model.number="projectState.options.maxConcurrent" min="1" max="100" />
          </label>
          <label class="field" :title="t('固定所有图片生成的随机种子：同一种子下背景/CG/立绘的画风与角色更稳定一致。0 = 按小说标题自动派生')">
            <span>{{ t("固定种子（0 = 按标题自动派生）") }}</span>
            <input type="number" v-model.number="projectState.options.imageSeed" min="0" />
          </label>
          <label class="field">
            <span>{{ t("跳过缓存（全量重跑）") }}</span>
            <div style="padding-top: 6px"><input type="checkbox" v-model="projectState.options.skipCache" /></div>
          </label>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top: var(--space-4)">
      <div class="card-head">
        <h3>{{ t("本次执行阶段") }}</h3>
        <div class="card-actions">
          <button class="btn ghost small" @click="selectedStages = { split: true, translate: true, extract: true, script: true, image: true, voice: true, assemble: true }">{{ t("全选") }}</button>
          <button class="btn ghost small" @click="selectedStages = { split: false, translate: false, extract: false, script: false, image: false, voice: false, assemble: false }">{{ t("全不选") }}</button>
        </div>
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 10px 22px">
        <label v-for="s in STAGE_ORDER" :key="s" style="display: flex; align-items: center; gap: 6px; font-size: 13px">
          <input type="checkbox" v-model="selectedStages[s]" />
          {{ t(STAGE_LABELS[s]) }}
          <span v-if="s === 'split'" style="color: var(--text-faint); font-size: 11px">{{ t("AI 识别章节边界（多文件合并/未切章时必开）") }}</span>
          <span v-else-if="s === 'translate'" style="color: var(--text-faint); font-size: 11px">{{ t("小说→目标语言（需 LLM）") }}</span>
          <span v-else-if="s === 'extract'" style="color: var(--text-faint); font-size: 11px">{{ t("角色/场景/物品卡") }}</span>
          <span v-else-if="s === 'script'" style="color: var(--text-faint); font-size: 11px">{{ t("分章分镜") }}</span>
          <span v-else-if="s === 'image'" style="color: var(--text-faint); font-size: 11px">{{ t("立绘/背景/CG/物品图") }}</span>
          <span v-else-if="s === 'voice'" style="color: var(--text-faint); font-size: 11px">{{ t("逐句配音") }}</span>
          <span v-else style="color: var(--text-faint); font-size: 11px">{{ t("写入游戏文件") }}</span>
        </label>
      </div>
      <p style="color: var(--text-dim); font-size: 12px; margin-top: var(--space-2)">
        {{ t("未勾选的阶段会复用已有结果（卡片/剧本/素材），不会重新计费；若某阶段从未运行过则会提示需先运行。") }}
      </p>
    </div>

    <div class="card" v-if="projectState.novel" style="margin-top: var(--space-4)">
      <div class="card-head">
        <h3>{{ t("本次重跑章节") }}</h3>
        <div class="card-actions">
          <button class="btn ghost small" @click="toggleAllRerun(true)">{{ t("全选") }}</button>
          <button class="btn ghost small" @click="toggleAllRerun(false)">{{ t("全不选") }}</button>
        </div>
      </div>
      <p style="font-size: 12px; color: var(--text-dim); margin-bottom: var(--space-3)">{{ t("未勾选章节复用已有缓存；无缓存则跳过") }}</p>
      <div style="display: flex; flex-wrap: wrap; gap: 6px 18px">
        <label v-for="(ch, i) in projectState.novel.chapters" :key="i" style="display: flex; align-items: center; gap: 5px; font-size: 12.5px">
          <input
            type="checkbox"
            :checked="rerunChapters === null || rerunChapters.includes(ch.index)"
            @change="(e: any) => toggleChapterRerun(ch.index, (e.target as HTMLInputElement).checked)"
          />
          {{ ch.title }}
        </label>
      </div>
    </div>

    <div class="card" v-if="projectState.lastResult" style="margin-top: var(--space-4)">
      <div class="card-head"><h3>{{ t("分阶段操作（不满意可单独重生成）") }}</h3></div>
      <div style="display: flex; flex-direction: column; gap: 10px">
        <div class="stage-row">
          <div class="stage-row-label"><span class="stage-dot">①</span><b>{{ t("分章") }}</b></div>
          <input type="text" v-model="stageFeedback.split" :placeholder="t('意见（可选）：如「每章约 8000 字，按剧情自然切分」…')" />
          <button class="btn small" :disabled="busy" @click="runSplitRegen">{{ t("重新分章（连后续）") }}</button>
        </div>
        <div class="stage-row">
          <div class="stage-row-label"><span class="stage-dot">②</span><b>{{ t("翻译") }}</b></div>
          <input type="text" v-model="stageFeedback.translate" :placeholder="t('意见（可选）：如「人名保持拼音，语气更自然」…')" />
          <button class="btn small" :disabled="busy" @click="runTranslateRegen">{{ t("重新翻译（连后续）") }}</button>
        </div>
        <div class="stage-row">
          <div class="stage-row-label"><span class="stage-dot">③</span><b>{{ t("提取卡片") }}</b></div>
          <input type="text" v-model="stageFeedback.extract" :placeholder="t('意见（可选）：如「主角要有两个女性角色」…')" />
          <button class="btn small" :disabled="busy" @click="runExtractRegen">{{ t("重新提取（连剧本/图像）") }}</button>
        </div>
        <div class="stage-row">
          <div class="stage-row-label"><span class="stage-dot">④</span><b>{{ t("剧本") }}</b></div>
          <input type="text" v-model="stageFeedback.script" :placeholder="t('意见（可选）：如「对话更口语化，高潮更激烈」…')" />
          <button class="btn small" :disabled="busy" @click="runScriptRegen">{{ t("重新剧本（全部章节）") }}</button>
        </div>
        <div class="stage-row">
          <div class="stage-row-label"><span class="stage-dot">⑤</span><b>{{ t("图像") }}</b></div>
          <input type="text" v-model="stageFeedback.image" :placeholder="t('意见（可选）：如「整体更有电影感，背景更精致」…')" />
          <button class="btn small" :disabled="busy" @click="runImageRegen">{{ t("重新生成全部图像") }}</button>
        </div>
        <div class="stage-row">
          <div class="stage-row-label"><span class="stage-dot">⑥</span><b>{{ t("配音") }}</b></div>
          <span style="color: var(--text-faint); font-size: 12px">{{ t("TTS 不接收意见；如需重配请点击右侧按钮（全部重配）") }}</span>
          <button class="btn small" :disabled="busy" @click="runVoiceRegen">{{ t("重新配音（全部）") }}</button>
        </div>
        <div class="stage-row">
          <div class="stage-row-label"><span class="stage-dot">⑦</span><b>{{ t("组装") }}</b></div>
          <span style="color: var(--text-faint); font-size: 12px">{{ t("把当前卡片/剧本/素材重新写入游戏目录") }}</span>
          <button class="btn small" :disabled="busy" @click="runAssemble">{{ t("重新组装") }}</button>
        </div>
      </div>
      <p style="color: var(--text-dim); font-size: 12px; margin-top: var(--space-2)">
        {{ t("单条立绘 / 单句配音的重生成请在下方「素材」页操作。") }}
      </p>
    </div>

    <p v-if="error" style="color: var(--err); margin: var(--space-3) 0">{{ error }}</p>

    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'run' }" @click="tab = 'run'">{{ t("状态与费用") }}</button>
      <button class="tab" :class="{ active: tab === 'cards' }" @click="tab = 'cards'">{{ t("卡片编辑") }}</button>
      <button class="tab" :class="{ active: tab === 'asset' }" @click="tab = 'asset'; loadAssetMapNow()">{{ t("素材") }}</button>
      <button class="tab" :class="{ active: tab === 'bible' }" @click="tab = 'bible'">
        {{ t("视觉圣经") }}
        <span v-if="visualBibleReviewNeeded" class="tab-badge">{{ t("待确认") }}</span>
      </button>
      <button class="tab" :class="{ active: tab === 'video' }" @click="tab = 'video'; checkVideos()">{{ t("视频推荐位") }}</button>
      <button class="tab" :class="{ active: tab === 'script' }" @click="tab = 'script'; loadScripts()">{{ t("剧本") }}</button>
      <button class="tab" :class="{ active: tab === 'failed' }" @click="tab = 'failed'">
        {{ t("失败项") }}<template v-if="failedTasks.length">（{{ failedTasks.length }}）</template>
      </button>
      <button class="tab" :class="{ active: tab === 'log' }" @click="tab = 'log'">{{ t("日志") }}</button>
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
      <div class="card" v-if="liveProgress && busy" style="margin-top: var(--space-4)">
        <div class="card-head">
          <h3>{{ t("实时进度") }}</h3>
          <span style="color: var(--text-faint); font-size: 12px">{{ liveProgress.done }}/{{ liveProgress.total }} · {{ livePct }}%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" :style="{ width: livePct + '%' }"></div></div>
        <p style="color: var(--text-dim); font-size: 12px; margin-top: var(--space-2)">
          {{ liveProgress.step }} · {{ t("当前：") }}{{ liveProgress.label }}
        </p>
      </div>
      <div class="card" v-if="costText" style="margin-top: var(--space-4)">
        <div class="card-head"><h3>{{ t("费用统计（估算）") }}</h3></div>
        <div class="stat-grid">
          <div class="stat"><span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg></span><div class="stat-body"><div class="label">LLM</div><div class="value" style="font-size: 15px">{{ costText.llm }}</div></div></div>
          <div class="stat"><span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg></span><div class="stat-body"><div class="label">{{ t("图像") }}</div><div class="value" style="font-size: 15px">{{ costText.image }}</div></div></div>
          <div class="stat"><span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6V18M8 9V15M16 9V15M5 11V13M19 11V13" /></svg></span><div class="stat-body"><div class="label">{{ t("配音") }}</div><div class="value" style="font-size: 15px">{{ costText.tts }}</div></div></div>
          <div class="stat"><span class="stat-icon" style="background: var(--gradient-hot)"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg></span><div class="stat-body"><div class="label">{{ t("合计") }}</div><div class="value" style="font-size: 16px">¥{{ costText.total }}</div></div></div>
        </div>
        <p style="color: var(--text-dim); font-size: 12px; margin-top: var(--space-3)">{{ t("图像按 ¥0.3/张、文本按 ¥2+8/百万 token 估算；视频由你人工生成不计费；缓存命中不重复计费。") }}</p>
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
          </div>
        </div>

        <div class="card" style="margin-top: var(--space-4)">
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
                </div>
                <div v-for="e in row.emotions" :key="e.emo" class="asset-thumb" :class="{ missing: !e.file }" :title="`${EMOTION_LABELS[e.emo]}（点击放大）`" @click="e.file && openPreview(e.file, `${row.name} · ${EMOTION_LABELS[e.emo]}`)">
                  <label class="asset-sel" @click.stop><input type="checkbox" :checked="selected.has(`figure:${row.id}:${e.emo}`)" @change="toggleSelect(`figure:${row.id}:${e.emo}`)" /></label>
                  <LazyThumb v-if="e.file" :path="e.file" :alt="EMOTION_LABELS[e.emo]" />
                  <span class="thumb-label">{{ EMOTION_LABELS[e.emo] }}</span>
                  <button class="btn ghost small" :disabled="!!assetBusy" @click.stop="regenFigureEmotion(row.id, e.emo)">{{ t("重生成") }}</button>
                </div>
              </div>
              <div v-if="row.actions.length" style="border-top: 1px dashed var(--border); margin-top: 8px; padding-top: 8px">
                <div class="asset-thumb-row">
                  <div v-for="a in row.actions" :key="a.id" class="asset-thumb" :class="{ missing: !a.file }" :title="`${a.name}（点击放大）`" @click="a.file && openPreview(a.file, `${row.name} · ${a.name}`)">
                    <label class="asset-sel" @click.stop><input type="checkbox" :checked="selected.has(`action:${row.id}:${a.id}`)" @change="toggleSelect(`action:${row.id}:${a.id}`)" /></label>
                    <LazyThumb v-if="a.file" :path="a.file" :alt="a.name" />
                    <span class="thumb-label">{{ a.name }}</span>
                    <button class="btn ghost small" :disabled="!!assetBusy" @click.stop="regenAction(row.id, a.id, a.name)">{{ t("重生成") }}</button>
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
                <button class="btn ghost small" v-for="c in voiceCharOptions" :key="c.value" @click="regenCharVoice(c.value)" :disabled="!!assetBusy">
                  {{ t("重配「") }}{{ c.label }}{{ t("」全部") }}
                </button>
              </div>
            </div>
            <div class="row" style="margin-bottom: 12px">
              <label class="field" style="flex: 1; margin-bottom: 0">
                <span>{{ t("章节筛选") }}</span>
                <select v-model="voiceChapterFilter">
                  <option :value="0">{{ t("全部章节") }}</option>
                  <option v-for="o in voiceChapterOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </label>
              <label class="field" style="flex: 1; margin-bottom: 0">
                <span>{{ t("角色筛选") }}</span>
                <select v-model="voiceCharFilter">
                  <option value="">{{ t("全部角色") }}</option>
                  <option v-for="c in voiceCharOptions" :key="c.value" :value="c.value">{{ c.label }}</option>
                </select>
              </label>
            </div>
            <div v-for="row in voiceRowsShown" :key="row.key" class="asset-row voice">
              <div style="flex: 1; min-width: 0">
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                  <span class="tag">{{ row.chapter }}</span>
                  <span style="font-weight: 600; font-size: 13px">{{ charNameOf(row.charId) }}</span>
                  <span style="color: var(--text-faint); font-size: 11px">{{ row.scene }}</span>
                  <span class="tag" :class="row.file ? 'ok' : ''">{{ fileExistsLabel(row.file) }}</span>
                </div>
                <div style="color: var(--text-dim); font-size: 12px; margin-top: 4px; word-break: break-all">{{ row.text }}</div>
              </div>
              <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0">
                <button v-if="row.file" class="btn ghost small" @click="playVoice(row.key, row.file)">{{ playingVoiceKey === row.key ? t("⏸ 停止") : t("▶ 试听") }}</button>
                <button class="btn small" :disabled="!!assetBusy" @click="regenVoice(row.key)">{{ t("重配") }}</button>
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
        <p style="color: var(--text-dim); font-size: 12px; margin-bottom: var(--space-4)">{{ t("提示词粘贴到即梦/可灵生成，mp4 命名为") }} <code>video_&lt;id&gt;.mp4</code> {{ t("放入") }} <code>game/video/</code> {{ t("刷新后自动启用，零 API 费用。") }}</p>
        <div v-for="vp in videoPoints" :key="vp.id" style="border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; margin-bottom: 10px">
          <div class="row" style="justify-content: space-between">
            <span>
              <span class="tag" :class="vp.enabled ? 'ok' : ''">{{ vp.enabled ? t("已启用") : t("未生成") }}</span>
              <span style="font-weight: 600">{{ vp.title }}</span>
              <span style="color: var(--text-dim); font-size: 12px; margin-left: 8px">{{ t("第") }} {{ vp.chapter }} {{ t("章") }} · {{ vp.location }} · {{ vp.durationSecs }}s</span>
            </span>
            <button class="btn small" @click="copyText(vp.videoPrompt, '视频提示词')">{{ t("复制提示词") }}</button>
          </div>
          <p style="color: var(--text-dim); font-size: 12px; margin-top: 6px">{{ vp.description }}</p>
          <p style="font-size: 12px; margin-top: 6px; color: var(--text-dim)">{{ t("文件名：") }}<code>video_{{ sanitizeId(vp.id) }}.mp4</code></p>
        </div>
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
          <p style="color: var(--text-dim); font-size: 12px; margin-bottom: var(--space-3)">{{ t("选择章节 → 填写意见（可留空 = 直接重新生成）→ 点击「重新生成此章」。其余章节自动复用缓存。") }}</p>
        <div v-for="ch in projectState.novel?.chapters ?? []" :key="ch.index" class="stage-row" style="margin-bottom: 8px">
          <div class="stage-row-label"><b>{{ ch.title }}</b></div>
          <input type="text" v-model="scriptChapterFeedback[ch.index]" :placeholder="t('意见（可选）：这一章节奏太慢，希望更快推进…')" />
          <button class="btn small" :disabled="busy" @click="regenChapter(ch.index)">{{ t("重新生成此章") }}</button>
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
          <div class="card-actions"><button class="btn small" @click="retryFailed">{{ t("定位重试") }}</button></div>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px">
          <div v-for="(f, i) in failedTasks" :key="i" style="border: 1px solid var(--err-soft); background: var(--err-soft); border-radius: var(--radius-sm); padding: 10px 12px">
            <div style="display: flex; align-items: center; gap: 8px">
              <span class="tag err">{{ f.kind === "image" ? t("图像") : f.kind === "script" ? t("剧本") : f.kind === "llm" ? "LLM" : t("配音") }}</span>
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
          <div v-for="(l, i) in projectState.logs" :key="i" class="log-line" :class="l.level">
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
