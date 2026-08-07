import type {
  ApiConfig,
  AssetMap,
  ChapterScript,
  ExtractionResult,
  ImageTask,
  MaterialAsset,
  PipelineEvent,
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
 */
export async function regenerateImages(
  ctx: RegenContext,
  predicate: (task: ImageTask) => boolean,
  feedback?: string,
): Promise<RegenImageResult[]> {
  const cacheRoot = cacheRootFor(ctx.outputDir);
  const tasks = buildImageTasks(ctx.chapters, ctx.cards, {
    figureEmotions: ctx.figureEmotions ?? true,
    threeView: ctx.threeView !== false,
    actions: ctx.actions !== false,
    style: ctx.style,
    feedback,
  }).filter(predicate);
  if (!tasks.length) return [];

  // 图生图参考链：三视图 → 默认立绘 → 表情；任一被重生成后立即更新参考路径
  const figureBase: Record<string, string> = {};
  for (const t of tasks) {
    if (t.refFromTask && !figureBase[t.refFromTask]) {
      const refTask = tasks.find((x) => x.id === t.refFromTask);
      if (refTask) {
        const cached = await tauri
          .pathExists(`${cacheRoot}/images/${refTask.fileName}`)
          .then((ok) => (ok ? `${cacheRoot}/images/${refTask.fileName}` : null))
          .catch(() => null);
        if (cached) figureBase[t.refFromTask] = cached;
      }
    }
  }

  const results: RegenImageResult[] = [];
  for (const task of tasks) {
    const path = await runImageTask(ctx.cfg, task, cacheRoot, ctx.log, {
      materials: ctx.materials,
      force: true,
      figureBase,
      verifyCfg: ctx.verifyCfg,
    });
    if (path) {
      results.push({ task, path });
      figureBase[task.id] = path;
    }
  }
  await mergeAssetMap(ctx.outputDir, results);
  return results;
}

/** 重新生成某个角色的全部立绘（默认 + 表情差分） */
export function regenerateCharacterFigures(
  ctx: RegenContext,
  charId: string,
  feedback?: string,
): Promise<RegenImageResult[]> {
  return regenerateImages(ctx, (t) => t.kind === "figure" && (t.id === charId || t.id.startsWith(`${charId}_`)), feedback);
}

/** 重新生成某个角色的三视图；由于它是立绘/表情/动作的图生图基准，会级联重生成该角色全部图像 */
export function regenerateCharacterThreeView(
  ctx: RegenContext,
  charId: string,
  feedback?: string,
): Promise<RegenImageResult[]> {
  return regenerateImages(
    ctx,
    (t) =>
      t.kind === "threeview" ||
      (t.kind === "figure" && (t.id === charId || t.id.startsWith(`${charId}_`))) ||
      (t.kind === "action" && t.id.startsWith(`${charId}_act_`)),
    feedback,
  );
}

/** 重新生成某个角色的单个动作立绘 */
export function regenerateCharacterAction(
  ctx: RegenContext,
  charId: string,
  actionId: string,
  feedback?: string,
): Promise<RegenImageResult[]> {
  return regenerateImages(ctx, (t) => t.kind === "action" && t.id === `${charId}_act_${actionId}`, feedback);
}

/** 重新生成某个物品图 */
export function regenerateItemImage(
  ctx: RegenContext,
  itemId: string,
  feedback?: string,
): Promise<RegenImageResult[]> {
  return regenerateImages(ctx, (t) => t.kind === "item" && t.id === itemId, feedback);
}

/** 重新生成某个场景背景图 */
export function regenerateBackground(
  ctx: RegenContext,
  sceneId: string,
  feedback?: string,
): Promise<RegenImageResult[]> {
  return regenerateImages(ctx, (t) => t.kind === "background" && t.id === sceneId, feedback);
}

/** 重新生成某张 CG */
export function regenerateCg(
  ctx: RegenContext,
  chapterNo: number,
  sceneId: string,
  feedback?: string,
): Promise<RegenImageResult[]> {
  return regenerateImages(ctx, (t) => t.kind === "cg" && t.id === `${chapterNo}_${sceneId}`, feedback);
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
export async function regenerateCharacterVoice(ctx: RegenContext, charId: string): Promise<number> {
  const tts = ctx.ttsCfg;
  if (!tts) return 0;
  const jobs = buildVoiceJobs(tts, ctx.chapters, ctx.cards.characters).filter((j) => j.charId === charId);
  let count = 0;
  for (const job of jobs) {
    const path = await runVoiceJob(tts, job, cacheRootFor(ctx.outputDir), ctx.log, true);
    if (path) {
      await mergeVocal(ctx.outputDir, job.key, path);
      count++;
    }
  }
  return count;
}
