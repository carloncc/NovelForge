import { reactive, watch } from "vue";
import type {
  ChapterScript,
  CostStats,
  GenerationOptions,
  MaterialAsset,
  NovelDoc,
  PipelineEvent,
  PipelineResult,
  ProjectMeta,
  ProjectVisualBible,
} from "../core/types";
import { saveProjectState, restoreProjectState, readWorkingCards } from "../utils/persist";
import { tauri } from "../utils/tauri";
import { log } from "../utils/logger";
import { clearThumbCache } from "../composables/useAssetThumbs";
import { STEP_TO_STAGE, type StageKey } from "../core/types";
import { parseChapterScript } from "../core/dataValidation";
import { runStatusSetFailed } from "./runStatus";

export interface ProjectState {
  novel: NovelDoc | null;
  materials: MaterialAsset[];
  outputDir: string;
  options: GenerationOptions;
  lastResult: PipelineResult | null;
  visualBible: ProjectVisualBible | null;
  visualBibleWarnings: string[];
  saveError: string | null;
  logs: PipelineEvent[];
  running: boolean;
}

const DEFAULT_OPTIONS: GenerationOptions = {
  useImage: true,
  useTts: false,
  useVideoPoints: true,
  // 声音默认开启（#536）：无 BGM 文件时不输出 bgm 指令；内置 SE 有文件就播，
  // 避免新项目默认成「哑剧」（此前默认关闭，标题页与所有场景静音）
  useBgm: true,
  useSe: true,
  figureEmotions: true,
  figureDetail: "full",
  figureActions: true,
  characterPoses: true,
  imageSelfCheck: false,
  imageBudgetPerChapter: 0,
  cgPerChapter: 0,
  skipCache: false,
  videoPointsPerChapter: 0,
  characterIntroCard: true,
  imageStyle: "",
  imageSeed: 0,
  styleAnchor: true,
  scriptStyle: "",
  language: "",
  splitMinChapterChars: 3000,
  splitKeepSpecials: false,
  extractChunkChars: 0,
  autoCascadeDownstream: true,
};

export const projectState = reactive<ProjectState>({
  novel: null,
  materials: [],
  outputDir: "",
  options: { ...DEFAULT_OPTIONS },
  lastResult: null,
  visualBible: null,
  visualBibleWarnings: [],
  saveError: null,
  logs: [],
  running: false,
});

let saveTimer: number | undefined;

interface ProjectSnapshot {
  novel: NovelDoc | null;
  materials: MaterialAsset[];
  outputDir: string;
  options: GenerationOptions;
  lastResult: { meta: PipelineResult["meta"]; cards: PipelineResult["cards"]; cost: PipelineResult["cost"] } | null;
  visualBible: ProjectVisualBible | null;
}

/**
 * B32：快照改为浅拷贝——只组装需要持久化的顶层字段，小说/素材/选项等按引用共享。
 * 旧实现每次保存都做一次整树 JSON 深拷贝（含整本正文与全部卡片），在保存频繁时会明显卡顿；
 * saveProjectState 内部会自行裁剪写入结构（只持久化需要落盘的章节元数据），无需在此深拷贝。
 */
function snapshotProjectState(): ProjectSnapshot {
  const lastResult = projectState.lastResult;
  return {
    novel: projectState.novel,
    materials: projectState.materials,
    outputDir: projectState.outputDir,
    options: projectState.options,
    lastResult: lastResult ? { meta: lastResult.meta, cards: lastResult.cards, cost: lastResult.cost } : null,
    visualBible: projectState.visualBible,
  };
}

/** 轻量稳定哈希（djb2），用于快照变更检测；正文只用来判等，不参与持久化 */
function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${h.toString(36)}`;
}

/** 上次成功写盘的快照指纹（B32）：AI 分章项目的 project_state.json 内嵌整本分章正文快照，
 *  每次 scheduleSave 都重写数 MB；指纹未变（内容未变）时直接跳过写盘。 */
let lastPersistedSignature = "";

function snapshotSignature(snapshot: ProjectSnapshot): string {
  const novel = snapshot.novel;
  return JSON.stringify({
    out: snapshot.outputDir,
    materials: snapshot.materials.map((m) => `${m.kind}:${m.path}:${m.name}:${m.extra?.mapTo ?? ""}`),
    options: snapshot.options,
    novel: novel
      ? {
          head: `${novel.sourcePath}|${(novel.sourcePaths ?? []).join("|")}|${novel.fileName}|${novel.encoding}`,
          full: hashText(novel.fullText ?? ""),
          chapters: novel.chapters.map((c) => `${c.index}:${c.title}:${c.enabled ?? true}:${hashText(c.text ?? "")}`),
        }
      : null,
    result: snapshot.lastResult
      ? {
          meta: snapshot.lastResult.meta,
          cost: snapshot.lastResult.cost,
          // 与 saveProjectState 的落盘口径一致：内联参考图（base64）不参与持久化也不参与指纹
          cards: hashText(JSON.stringify(snapshot.lastResult.cards, (key, value) => (key === "referenceImage" ? undefined : value))),
        }
      : null,
    bible: snapshot.visualBible ? hashText(JSON.stringify(snapshot.visualBible)) : null,
  });
}

async function persistSnapshot(snapshot: ProjectSnapshot): Promise<boolean> {
  if (!snapshot.outputDir) return true;
  const signature = snapshotSignature(snapshot);
  if (signature === lastPersistedSignature && projectState.saveError === null) return true;
  try {
    await saveProjectState(snapshot);
    lastPersistedSignature = signature;
    projectState.saveError = null;
    return true;
  } catch (error) {
    projectState.saveError = error instanceof Error ? error.message : String(error);
    log.error("store", "项目状态保存失败", {
      outputDir: snapshot.outputDir,
      error: projectState.saveError,
    });
    return false;
  }
}

export async function persistCurrentProjectState(): Promise<boolean> {
  return persistSnapshot(snapshotProjectState());
}

/** 启动恢复期间挂起自动保存：否则恢复完成前的 800ms 防抖会把"空状态"写回磁盘，
 *  项目状态文件（含已导入小说/卡片/失败项）被静默清空（大项目恢复耗时 >800ms 时必现）。 */
let projectSaveSuspended = false;
export function suspendProjectSave(suspended: boolean): void {
  projectSaveSuspended = suspended;
}

export function scheduleSave(): void {
  if (projectSaveSuspended) return;
  if (saveTimer !== undefined) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    const snapshot = snapshotProjectState();
    log.debug("store", "持久化项目状态", {
      hasNovel: !!snapshot.novel,
      materials: snapshot.materials.length,
      outputDir: snapshot.outputDir,
    });
    void persistSnapshot(snapshot);
  }, 800);
}

export async function flushPendingProjectSave(): Promise<boolean> {
  if (saveTimer === undefined) return true;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  return persistCurrentProjectState();
}

export async function restoreProject(outputDir: string): Promise<void> {
  // 恢复期间挂起自动保存：否则恢复完成前的 800ms 防抖会把"空状态"写回磁盘（大项目恢复 >800ms 必现，
  // 项目状态文件被静默清空）。
  suspendProjectSave(true);
  // B31：无论成功还是失败都必须解挂（finally）。旧实现失败时保持挂起，一次「加载项目」失败
  // 就会让自动保存永久停摆（后续所有改动都不落盘）；失败时 projectState.outputDir 尚未切换，
  // 解挂后的保存仍指向旧项目，不会把新目录的状态文件清空。
  try {
    const projectChanged = outputDir !== projectState.outputDir;
    if (projectChanged && !(await flushPendingProjectSave())) {
      throw new Error("当前项目保存失败，已取消切换项目");
    }
    log.info("store", "恢复项目状态", { outputDir });
    const r = await restoreProjectState(outputDir);
    if (r.loadError) throw new Error(`项目状态读取失败：${r.loadError}`);
    if (projectChanged) {
      clearThumbCache();
      clearLogs();
    }
    projectState.outputDir = outputDir;
    projectState.visualBible = r.visualBible;
    projectState.visualBibleWarnings = r.warnings;
    for (const warning of r.warnings) log.warn("store", warning, { outputDir });
    projectState.novel = r.novel;
    projectState.materials = r.materials;
    projectState.options = { ...DEFAULT_OPTIONS, ...(r.options ?? {}) };
    projectState.lastResult = null;
    // 卡片以磁盘上的工作副本为准（与 pipeline.loadCards 同源）：project_state.json 里的
    // cards 只是上次保存时的快照，生成结束后不一定落盘过，重启后可能与 cards.json 不一致。
    // 不一致会直接打断图像生成：视觉守门批准时用快照算指纹、图像阶段用磁盘算指纹，
    // 于是「刚批准就判输入已变化 → 视觉守门失效 → 图像永不生成」。
    const workingCards = await readWorkingCards(outputDir);
    const snapshot = r.lastResult;
    // 快照里连 lastResult 都没有时（上一轮生成还没保存就退出/被中断），用磁盘上的
    // cards.json + meta.json 把它补出来：否则重启后「单阶段重跑」整块面板变成
    // 「还没有生成结果」，视觉守门的准备/批准按钮拿不到卡片而静默失败（0 个角色），
    // 素材页也是空的，且批准出来的指纹不含任何角色，图像阶段用磁盘卡片复算必然不一致
    // → 视觉守门永远判「输入已变化」，图片一张也生成不出来。
    if (snapshot || workingCards) {
      const chapters = await loadCachedChapters(outputDir);
      const failedTasks = await loadFailedTasks(outputDir);
      const meta = snapshot?.meta ?? (await loadDiskMeta(outputDir));
      log.debug("store", "恢复项目完成", {
        hasNovel: !!r.novel,
        materials: r.materials?.length ?? 0,
        cachedChapters: chapters.length,
        failedTasks: failedTasks.length,
        cardsFromDisk: !!workingCards,
        resultFromSnapshot: !!snapshot,
      });
      projectState.lastResult = {
        meta,
        cards: workingCards ?? snapshot!.cards,
        cost: snapshot?.cost ?? { ...EMPTY_COST },
        chapters,
        assets: {},
        failedTasks,
      };
    }
    projectState.saveError = null;
    // B35：侧栏失败徽标依赖 generate store 的 watch（懒加载，冷启动进入生成页前不执行）。
    // 恢复完成后直接把磁盘上的失败项数量同步到轻量 runStatus，冷启动也能显示徽标。
    runStatusSetFailed(projectState.lastResult?.failedTasks.length ?? 0);
  } finally {
    suspendProjectSave(false);
  }
}

/** 磁盘上没有费用快照时的零值（避免页面把 undefined 显示成 NaN） */
const EMPTY_COST: CostStats = {
  llmTokens: 0,
  imageCount: 0,
  ttsChars: 0,
  llmCostYuan: 0,
  imageCostYuan: 0,
  ttsCostYuan: 0,
};

// 项目元信息（标题/章节数/台词数/引擎版本）只在 .novel2vn/meta.json 里，
// project_state.json 的 lastResult 快照常常不存在，缺了 meta.json 就先生成空壳。
async function loadDiskMeta(outputDir: string): Promise<ProjectMeta> {
  const fallback: ProjectMeta = {
    title: "",
    gameKey: "",
    chapterCount: 0,
    charCount: 0,
    sceneCount: 0,
    lineCount: 0,
    outputDir,
    webgalVersion: "",
    generatedAt: "",
  };
  try {
    const file = `${outputDir}/.novel2vn/meta.json`;
    if (!(await tauri.pathExists(file))) return fallback;
    const { text } = await tauri.readTextFile(file);
    const meta = JSON.parse(text) as Partial<ProjectMeta> | null;
    if (!meta || typeof meta !== "object") return fallback;
    return { ...fallback, ...meta, outputDir };
  } catch {
    return fallback;
  }
}

// 从 .novel2vn/failed.json 恢复失败任务（中断/崩溃/重启后「失败项」仍可定位重试）
async function loadFailedTasks(outputDir: string): Promise<import("../core/types").FailedTask[]> {
  try {
    const file = `${outputDir}/.novel2vn/failed.json`;
    if (!(await tauri.pathExists(file))) return [];
    const { text } = await tauri.readTextFile(file);
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((f) => f && typeof f.id === "string" && typeof f.step === "string");
    }
    return [];
  } catch {
    return [];
  }
}

// 从磁盘缓存恢复各章剧本（供卡片/视频/剧本页在重启后仍可用）
async function loadCachedChapters(outputDir: string): Promise<ChapterScript[]> {
  try {
    const cacheDir = `${outputDir}/.novel2vn/cache`;
    const entries = await tauri.listDir(cacheDir);
    const latestByChapter = new Map<number, (typeof entries)[number]>();
    for (const entry of entries) {
      if (entry.isDir) continue;
      const match = entry.name.match(/^script(?:_demo)?_ch(\d+)_/);
      if (!match) continue;
      const chapterNumber = Number(match[1]);
      const current = latestByChapter.get(chapterNumber);
      if (!current || entry.name.localeCompare(current.name) > 0) latestByChapter.set(chapterNumber, entry);
    }
    const loaded = await Promise.all([...latestByChapter.values()].map(async (file) => {
      try {
        const { text } = await tauri.readTextFile(file.path);
        return parseChapterScript(JSON.parse(text));
      } catch {
        return undefined;
      }
    }));
    return loaded
      .filter((chapter): chapter is ChapterScript => chapter !== undefined)
      .sort((a, b) => a.chapter - b.chapter);
  } catch {
    return [];
  }
}

watch(
  () =>
    JSON.stringify({
      novelChapters: projectState.novel?.chapters.map((c) => ({ t: c.title, e: c.enabled })),
      novelMeta: projectState.novel
        ? { sourcePath: projectState.novel.sourcePath, fileName: projectState.novel.fileName }
        : null,
      materials: projectState.materials,
      outputDir: projectState.outputDir,
      options: projectState.options,
      lastMeta: projectState.lastResult?.meta.generatedAt,
      visualBible: projectState.visualBible,
    }),
  () => scheduleSave(),
  { deep: false },
);

export function clearLogs(): void {
  projectState.logs = [];
  for (const k of Object.keys(stageLastLevels) as StageKey[]) stageLastLevels[k] = undefined;
  lastActiveStage = undefined;
}

/** 增量维护：每个阶段日志的「最后一条级别」，避免每次 pushLog 全量扫描 2000 条日志 */
const stageLastLevels = reactive<Record<StageKey, PipelineEvent["level"] | undefined>>({
  split: undefined,
  translate: undefined,
  extract: undefined,
  script: undefined,
  image: undefined,
  voice: undefined,
  assemble: undefined,
});

/** 最近一条非 error 日志对应的阶段（当前正在执行/刚完成的阶段） */
let lastActiveStage: StageKey | undefined;

export function getStageLastLevels(): Record<StageKey, PipelineEvent["level"] | undefined> {
  return stageLastLevels;
}

export function getLastActiveStage(): StageKey | undefined {
  return lastActiveStage;
}

/** B36：每次运行开始时清除「最近活跃阶段」。
 *  lastActiveStage 增量维护且运行结束不清空，新一轮开始瞬间看板会把上一轮的阶段显示成「进行中」；
 *  由调用方（execute 置 busy=true 处）在运行开始时显式重置。 */
export function resetActiveStage(): void {
  lastActiveStage = undefined;
}

/** 清除某阶段的历史 error 标记（重试成功/确认恢复后调用）。
 * stageLastLevels 只保留「最后一条级别」，若阶段失败后不再产生新日志，error 会一直挂到
 * clearLogs；调用方可在此阶段重跑成功时调用本函数显式销账。 */
export function resetStageLevel(stage: StageKey): void {
  stageLastLevels[stage] = undefined;
  if (lastActiveStage === stage) lastActiveStage = undefined;
}

export function pushLog(ev: PipelineEvent): void {
  projectState.logs.push(ev);
  if (projectState.logs.length > 2000) {
    projectState.logs.splice(0, projectState.logs.length - 2000);
  }
  const stage = STEP_TO_STAGE[ev.step];
  if (stage) {
    // 阶段成功/进行中的新日志到达即覆盖旧 error：失败后重跑该阶段时红色状态会随新日志消除；
    // 无新日志的阶段仍需显式 resetStageLevel（或 clearLogs）。消费端（useStageStatus）
    // 同时应把 running 判定置于 failed 之前，避免重试期间仍显示失败。
    stageLastLevels[stage] = ev.level;
    if (ev.level !== "error") lastActiveStage = stage;
  }
}

export function addMaterial(mat: MaterialAsset): void {
  if (projectState.materials.some((m) => m.path === mat.path)) return;
  projectState.materials.push(mat);
}

export function removeMaterial(path: string): void {
  projectState.materials = projectState.materials.filter((m) => m.path !== path);
}
