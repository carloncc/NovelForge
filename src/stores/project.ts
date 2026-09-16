import { reactive, watch } from "vue";
import type {
  ChapterScript,
  CostStats,
  ExtractionResult,
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
  useBgm: false,
  useSe: false,
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

function snapshotProjectState(): ProjectSnapshot {
  const lastResult = projectState.lastResult;
  return JSON.parse(JSON.stringify({
    novel: projectState.novel,
    materials: projectState.materials,
    outputDir: projectState.outputDir,
    options: projectState.options,
    lastResult: lastResult ? { meta: lastResult.meta, cards: lastResult.cards, cost: lastResult.cost } : null,
    visualBible: projectState.visualBible,
  })) as ProjectSnapshot;
}

async function persistSnapshot(snapshot: ProjectSnapshot): Promise<boolean> {
  if (!snapshot.outputDir) return true;
  try {
    await saveProjectState(snapshot);
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
  // 项目状态文件被静默清空）。恢复成功才解挂；失败时保持挂起以保护原文件（重试成功会自动解挂）。
  suspendProjectSave(true);
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
  suspendProjectSave(false);
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

export function pushLog(ev: PipelineEvent): void {
  projectState.logs.push(ev);
  if (projectState.logs.length > 2000) {
    projectState.logs.splice(0, projectState.logs.length - 2000);
  }
  const stage = STEP_TO_STAGE[ev.step];
  if (stage) {
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
