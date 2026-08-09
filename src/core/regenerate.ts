import type {
  ApiConfig,
  AssetMap,
  ChapterScript,
  ExtractionResult,
  ImageTask,
  MaterialAsset,
  PipelineEvent,
  ProjectVisualBible,
} from "./types";
import { buildImageTasks, runImageTask } from "./images";
import { buildVoiceJobs, runVoiceJob } from "./voice";
import { tauri } from "../utils/tauri";

/** 单个素材重生成的共享上下文 */
export interface RegenContext {
  /** 图像 API（用于图像类重生成） */
  cfg: ApiConfig | undefined;
  /** TTS API（用于配音类重生成） */
  ttsCfg?: ApiConfig | undefined;
  chapters: ChapterScript[];
  cards: ExtractionResult;
  materials: MaterialAsset[];
  outputDir: string;
  log: (ev: PipelineEvent) => void;
  /** 统一画风（跟随生成页设置，保持一致） */
  style?: string;
  /** 是否生成表情差分（跟随生成页设置） */
  figureEmotions?: boolean;
  /** 是否包含三视图（跟随生成页设置） */
  threeView?: boolean;
  /** 是否包含动作立绘（跟随生成页设置） */
  actions?: boolean;
  /** 多模态模型自检（重生成时同样生效） */
  verifyCfg?: ApiConfig;
  /** 固定种子（跟随生成页设置，保持与管线一致） */
  imageSeed?: number;
  /** 是否启用风格锚点（跟随生成页设置） */
  styleAnchor?: boolean;
  visualBible?: ProjectVisualBible;
}

export interface RegenImageResult {
  task: ImageTask;
  path: string;
}

function cacheRootFor(outputDir: string): string {
  return `${outputDir}/.novel2vn/cache`;
}

function metaDirFor(outputDir: string): string {
  return `${outputDir}/.novel2vn`;
}

/** 把单个素材重新生成的结果合并进 assets.json，供「组装」阶段读取 */
async function mergeAssetMap(outputDir: string, results: RegenImageResult[]): Promise<void> {
  const file = `${metaDirFor(outputDir)}/assets.json`;
  let map: AssetMap = { bg: {}, cg: {}, figure: {}, item: {}, vocal: {} };
  try {
    const { text } = await tauri.readTextFile(file);
    map = JSON.parse(text) as AssetMap;
  } catch {
    /* 无旧映射 */
  }
  for (const r of results) {
    const target =
      r.task.kind === "background"
        ? map.bg
        : r.task.kind === "cg"
          ? map.cg
          : r.task.kind === "figure" || r.task.kind === "threeview" || r.task.kind === "action"
            ? map.figure
            : map.item;
    target[r.task.id] = r.path;
  }
  try {
    await tauri.writeTextFile(file, JSON.stringify(map, null, 2));
  } catch {
    /* 忽略 */
  }
}

/**
 * 按条件重新生成一批图像任务（跳过缓存、覆盖旧文件）。
 * predicate 接收单个任务，返回 true 的任务会被重生成。
 * signal.aborted() 返回 true 时停止调度后续任务（进行中的单张请求无法中断，完成即止）。
 * onProgress 每完成一张回调一次（done/total/label），用于界面显示实时进度。
 */
export async function regenerateImages(
  ctx: RegenContext,
  predicate: (task: ImageTask) => boolean,
  feedback?: string,
  signal?: { aborted: () => boolean },
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<RegenImageResult[]> {
  const cacheRoot = cacheRootFor(ctx.outputDir);
  const approvedBible = ctx.visualBible?.status === "approved" ? ctx.visualBible : undefined;
  const allTasks = buildImageTasks(ctx.chapters, ctx.cards, {
    figureEmotions: ctx.figureEmotions ?? true,
    threeView: ctx.threeView !== false,
    actions: ctx.actions !== false,
    style: approvedBible?.styleDescription ?? ctx.style,
    feedback,
    baseSeed: ctx.imageSeed,
    styleAnchor: approvedBible ? false : ctx.styleAnchor !== false,
  });
  const tasks = allTasks.filter(predicate);
  if (!tasks.length) return [];

  // 风格锚点：复用管线已生成的锚点图，保持重生成素材与整体画风一致
  const anchorPath = !approvedBible && ctx.styleAnchor !== false
    ? await tauri
        .pathExists(`${cacheRoot}/images/anchor_style.png`)
        .then((ok) => (ok ? `${cacheRoot}/images/anchor_style.png` : undefined))
        .catch(() => undefined)
    : undefined;

  // 图生图参考链：三视图 → 默认立绘 → 表情；任一被重生成后立即更新参考路径
  const figureBase: Record<string, string> = {};
  for (const t of tasks) {
    if (t.refFromTask && !figureBase[t.refFromTask]) {
      const refTask = allTasks.find((candidate) => candidate.id === t.refFromTask);
      if (refTask) {
        const cached = await tauri
          .pathExists(`${cacheRoot}/images/${refTask.fileName}`)
          .then((ok) => (ok ? `${cacheRoot}/images/${refTask.fileName}` : null))
          .catch(() => null);
        if (cached) figureBase[t.refFromTask] = cached;
      }
    }
  }

  const total = tasks.length;
  let done = 0;
  const results: RegenImageResult[] = [];
  for (const task of tasks) {
    if (signal?.aborted()) {
      ctx.log({
        step: "素材",
        message: `已中断（已完成 ${done}/${total}，其余未再生成）`,
        level: "warn",
        at: Date.now(),
      });
      break;
    }
    const path = await runImageTask(ctx.cfg, task, cacheRoot, ctx.log, {
      materials: ctx.materials,
      force: true,
      figureBase,
      visualBible: approvedBible,
      outputDir: ctx.outputDir,
      verifyCfg: ctx.verifyCfg,
      styleAnchorPath: anchorPath,
    });
    done++;
    onProgress?.(done, total, task.usage ?? task.fileName);
    if (path) {
      results.push({ task, path });
      figureBase[task.id] = path;
    }
  }
  await mergeAssetMap(ctx.outputDir, results);
  return results;
}

export function imageTaskMatchesSelectionKey(task: ImageTask, key: string): boolean {
  const parts = key.split(":");
  switch (parts[0]) {
    case "threeview": {
      const characterId = parts[1];
      return (task.kind === "threeview" && task.id === `${characterId}_threeview`)
        || ((task.kind === "figure" || task.kind === "action") && task.characterId === characterId);
    }
    case "figure":
      return task.kind === "figure" && task.id === (parts.length >= 3 ? `${parts[1]}_${parts[2]}` : parts[1]);
    case "action":
      return task.kind === "action" && task.id === `${parts[1]}_act_${parts[2]}`;
    case "item":
      return task.kind === "item" && task.id === parts[1];
    case "bg":
      return task.kind === "background" && task.id === parts[1];
    case "cg":
      return task.kind === "cg" && task.id === `${Number(parts[1]) - 1}_${parts[2]}`;
    default:
      return false;
  }
}

/** 重新生成某个角色的全部立绘（默认 + 表情差分） */
export function regenerateCharacterFigures(
  ctx: RegenContext,
  charId: string,
  feedback?: string,
  signal?: { aborted: () => boolean },
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<RegenImageResult[]> {
  return regenerateImages(ctx, (task) => task.kind === "figure" && task.characterId === charId, feedback, signal, onProgress);
}

/** 重新生成某个角色的三视图；由于它是立绘/表情/动作的图生图基准，会级联重生成该角色全部图像 */
export function regenerateCharacterThreeView(
  ctx: RegenContext,
  charId: string,
  feedback?: string,
  signal?: { aborted: () => boolean },
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<RegenImageResult[]> {
  const selectedTasks = selectCharacterThreeViewRegenerationTasks(ctx, charId, feedback);
  const selectedKeys = new Set(selectedTasks.map((task) => `${task.kind}:${task.id}:${task.fileName}`));
  return regenerateImages(
    { ...ctx, threeView: true, actions: true },
    (task) => selectedKeys.has(`${task.kind}:${task.id}:${task.fileName}`),
    feedback,
    signal,
    onProgress,
  );
}

export function selectCharacterThreeViewRegenerationTasks(
  ctx: RegenContext,
  charId: string,
  feedback?: string,
): ImageTask[] {
  const character = ctx.cards.characters.find((candidate) => candidate.id === charId);
  if (!character) return [];
  const approvedBible = ctx.visualBible?.status === "approved" ? ctx.visualBible : undefined;
  return buildImageTasks([], {
    title: ctx.cards.title,
    characters: [character],
    scenes: [],
    items: [],
  }, {
    figureEmotions: ctx.figureEmotions ?? true,
    threeView: true,
    actions: true,
    style: approvedBible?.styleDescription ?? ctx.style,
    feedback,
    baseSeed: ctx.imageSeed,
    styleAnchor: false,
  });
}

/** 重新生成某个角色的单个动作立绘 */
export function regenerateCharacterAction(
  ctx: RegenContext,
  charId: string,
  actionId: string,
  feedback?: string,
  signal?: { aborted: () => boolean },
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<RegenImageResult[]> {
  return regenerateImages(ctx, (t) => t.kind === "action" && t.id === `${charId}_act_${actionId}`, feedback, signal, onProgress);
}

/** 重新生成某个物品图 */
export function regenerateItemImage(
  ctx: RegenContext,
  itemId: string,
  feedback?: string,
  signal?: { aborted: () => boolean },
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<RegenImageResult[]> {
  return regenerateImages(ctx, (t) => t.kind === "item" && t.id === itemId, feedback, signal, onProgress);
}

/** 重新生成某个场景背景图 */
export function regenerateBackground(
  ctx: RegenContext,
  sceneId: string,
  feedback?: string,
  signal?: { aborted: () => boolean },
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<RegenImageResult[]> {
  return regenerateImages(ctx, (t) => t.kind === "background" && t.id === sceneId, feedback, signal, onProgress);
}

/** 重新生成某张 CG */
export function regenerateCg(
  ctx: RegenContext,
  chapterNo: number,
  sceneId: string,
  feedback?: string,
  signal?: { aborted: () => boolean },
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<RegenImageResult[]> {
  return regenerateImages(ctx, (t) => t.kind === "cg" && t.id === `${chapterNo}_${sceneId}`, feedback, signal, onProgress);
}

async function mergeVocal(outputDir: string, key: string, path: string): Promise<void> {
  const file = `${metaDirFor(outputDir)}/assets.json`;
  let map: AssetMap = { bg: {}, cg: {}, figure: {}, item: {}, vocal: {} };
  try {
    const { text } = await tauri.readTextFile(file);
    map = JSON.parse(text) as AssetMap;
  } catch {
    /* 无旧映射 */
  }
  map.vocal[key] = path;
  try {
    await tauri.writeTextFile(file, JSON.stringify(map, null, 2));
  } catch {
    /* 忽略 */
  }
}

/** 重新生成某一句对白的配音 */
export async function regenerateVoiceLine(ctx: RegenContext, key: string): Promise<string | null> {
  const tts = ctx.ttsCfg;
  if (!tts) return null;
  const jobs = buildVoiceJobs(tts, ctx.chapters, ctx.cards.characters);
  const job = jobs.find((j) => j.key === key);
  if (!job) return null;
  const path = await runVoiceJob(tts, job, cacheRootFor(ctx.outputDir), ctx.log, true);
  if (path) await mergeVocal(ctx.outputDir, key, path);
  return path;
}

/** 重新生成某个角色的全部配音 */
export async function regenerateCharacterVoice(
  ctx: RegenContext,
  charId: string,
  signal?: { aborted: () => boolean },
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<number> {
  const tts = ctx.ttsCfg;
  if (!tts) return 0;
  const jobs = buildVoiceJobs(tts, ctx.chapters, ctx.cards.characters).filter((j) => j.charId === charId);
  const total = jobs.length;
  let done = 0;
  let count = 0;
  for (const job of jobs) {
    if (signal?.aborted()) break;
    const path = await runVoiceJob(tts, job, cacheRootFor(ctx.outputDir), ctx.log, true);
    done++;
    onProgress?.(done, total, `${job.voice}「${job.text.slice(0, 12)}…」`);
    if (path) {
      await mergeVocal(ctx.outputDir, job.key, path);
      count++;
    }
  }
  return count;
}
