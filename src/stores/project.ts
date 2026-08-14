import { reactive, watch } from "vue";
import type {
  ChapterScript,
  GenerationOptions,
  MaterialAsset,
  NovelDoc,
  PipelineEvent,
  PipelineResult,
  ProjectVisualBible,
} from "../core/types";
import { saveProjectState, restoreProjectState } from "../utils/persist";
import { tauri } from "../utils/tauri";
import { log } from "../utils/logger";

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

export const projectState = reactive<ProjectState>({
  novel: null,
  materials: [],
  outputDir: "",
  options: {
    useImage: true,
    useTts: false,
    useVideoPoints: true,
    useBgm: true,
    figureEmotions: true,
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
  },
  lastResult: null,
  visualBible: null,
  visualBibleWarnings: [],
  saveError: null,
  logs: [],
  running: false,
});

let saveTimer: number | undefined;

export async function persistCurrentProjectState(): Promise<boolean> {
  const lastResult = projectState.lastResult;
  try {
    await saveProjectState({
      novel: projectState.novel,
      materials: projectState.materials,
      outputDir: projectState.outputDir,
      options: projectState.options,
      lastResult: lastResult
        ? { meta: lastResult.meta, cards: lastResult.cards, cost: lastResult.cost }
        : null,
      visualBible: projectState.visualBible,
    });
    projectState.saveError = null;
    return true;
  } catch (error) {
    projectState.saveError = error instanceof Error ? error.message : String(error);
    log.error("store", "项目状态保存失败", {
      outputDir: projectState.outputDir,
      error: projectState.saveError,
    });
    return false;
  }
}

export function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    log.debug("store", "持久化项目状态", {
      hasNovel: !!projectState.novel,
      materials: projectState.materials.length,
      outputDir: projectState.outputDir,
    });
    void persistCurrentProjectState();
  }, 800);
}

export async function restoreProject(outputDir: string): Promise<void> {
  log.info("store", "恢复项目状态", { outputDir });
  const r = await restoreProjectState(outputDir);
  projectState.visualBible = r.visualBible;
  projectState.visualBibleWarnings = r.warnings;
  for (const warning of r.warnings) log.warn("store", warning, { outputDir });
  if (r.novel) projectState.novel = r.novel;
  if (r.materials?.length) projectState.materials = r.materials;
  if (r.options) projectState.options = { ...projectState.options, ...r.options };
  if (r.lastResult) {
    const chapters = await loadCachedChapters(outputDir);
    log.debug("store", "恢复项目完成", {
      hasNovel: !!r.novel,
      materials: r.materials?.length ?? 0,
      cachedChapters: chapters.length,
    });
    projectState.lastResult = {
      meta: r.lastResult.meta,
      cards: r.lastResult.cards,
      cost: r.lastResult.cost,
      chapters,
      assets: {},
      failedTasks: [],
    };
  }
}

// 从磁盘缓存恢复各章剧本（供卡片/视频/剧本页在重启后仍可用）
async function loadCachedChapters(outputDir: string): Promise<ChapterScript[]> {
  try {
    const cacheDir = `${outputDir}/.novel2vn/cache`;
    const entries = await tauri.listDir(cacheDir);
    const files = entries
      .filter((e) => !e.isDir && /^script(_demo)?_ch\d+_/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const chapters: ChapterScript[] = [];
    for (const f of files) {
      try {
        const { text } = await tauri.readTextFile(f.path);
        const sc = JSON.parse(text) as ChapterScript;
        chapters[sc.chapter] = sc;
      } catch {
        /* 单个缓存损坏跳过 */
      }
    }
    return chapters.filter(Boolean);
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
}

export function pushLog(ev: PipelineEvent): void {
  projectState.logs.push(ev);
  if (projectState.logs.length > 2000) {
    projectState.logs.splice(0, projectState.logs.length - 2000);
  }
}

export function addMaterial(mat: MaterialAsset): void {
  if (projectState.materials.some((m) => m.path === mat.path)) return;
  projectState.materials.push(mat);
}

export function removeMaterial(path: string): void {
  projectState.materials = projectState.materials.filter((m) => m.path !== path);
}
