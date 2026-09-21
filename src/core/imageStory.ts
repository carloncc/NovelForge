/**
 * 图片小说（纯图片模式）图片通道（#806/#809/#810）：
 * - 任务构建：角色三视图（identity 参考，必须先行）＋ 每场景分镜（kind:"shot"）＋（可选）物品图；
 *   不产出立绘/表情/动作/服装差分，也不做抠图。
 * - 执行：按依赖分层（三视图 → 分镜/物品）并发执行，逐张回调结果供映射落盘；
 *   三视图失败的角色，其分镜不静默降级为纯文生图（#814 决策 7），直接记为失败并给出可执行提示。
 */
import type { ApiConfig, ChapterScript, ExtractionResult, ImageStoryOptions, ImageTask, PipelineEvent } from "./types";
import { buildImageTasks, runImageTask } from "./images";
import { errMsg } from "../utils/errors";

/** 每张图片的预估单价（元）：与 pipeline 的 DEFAULT_PRICES.imageYuanEach 同口径 */
export const IMAGE_YUAN_EACH = 0.3;

export interface ImageStoryTaskPlan {
  tasks: ImageTask[];
  threeviewCount: number;
  shotCount: number;
  itemCount: number;
  /** 预计费用（元，按全部任务计；命中缓存不重复计费，实际支出 ≤ 该值） */
  estimatedYuan: number;
}

/** 图片小说任务计划（纯函数）：生成前算总账、运行前按同一口径执行 */
export function buildImageStoryPlan(
  chapters: ChapterScript[],
  cards: ExtractionResult,
  options: ImageStoryOptions,
): ImageStoryTaskPlan {
  const tasks = buildImageTasks(chapters, cards, {
    mode: "imageOnly",
    shotsPerScene: options.shotsPerScene ?? 0,
    shotsPerChapter: options.shotsPerChapter ?? 0,
    shotsTotal: options.shotsTotal ?? 0,
    includeItems: !!options.includeItems,
    style: options.imageStyle,
    styleAnchor: options.styleAnchor !== false,
    threeView: true,
    actions: false,
    figureEmotions: false,
    detail: "core",
    ...(options.imageSeed > 0 ? { baseSeed: options.imageSeed } : {}),
  });
  const threeviewCount = tasks.filter((t) => t.kind === "threeview").length;
  const shotCount = tasks.filter((t) => t.kind === "shot").length;
  const itemCount = tasks.filter((t) => t.kind === "item").length;
  return {
    tasks,
    threeviewCount,
    shotCount,
    itemCount,
    estimatedYuan: Math.round(tasks.length * IMAGE_YUAN_EACH * 100) / 100,
  };
}

/** 简单并发池（图片任务彼此独立；限流由 API 层配置兜底） */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length || 1)) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export interface ImageStoryRunArgs {
  cfg: ApiConfig | undefined;
  tasks: ImageTask[];
  /** <outputDir>/.novel2vn/cache */
  cacheRoot: string;
  outputDir: string;
  concurrency: number;
  isAborted: () => boolean;
  log: (ev: PipelineEvent) => void;
  verifyCfg?: ApiConfig;
  visionCfg?: ApiConfig;
  safeRewriteCfg?: ApiConfig;
  styleAnchorPath?: string;
  /** 任务完成（含缓存命中）后回调，用于落盘映射 */
  onTaskDone: (task: ImageTask, path: string) => void;
  onTaskFailed: (task: ImageTask, message: string) => void;
  /** 强制重生成（跳过缓存，覆盖同名文件）：单张重生成用 */
  force?: boolean;
}

/** 执行图片小说任务：三视图先行，随后分镜/物品；返回成功与失败计数（中断时未派发的不计失败） */
export async function runImageStoryTasks(args: ImageStoryRunArgs): Promise<{ produced: number; failed: number }> {
  const figureBase: Record<string, string> = {};
  const failedThreeviews = new Set<string>();
  let produced = 0;
  let failed = 0;
  /** 风格锚点产物路径：锚点任务完成后作为无角色分镜的画风参考（有 identity 参考的任务不吃锚点） */
  let anchorPath: string | undefined;

  const runOne = async (task: ImageTask): Promise<void> => {
    if (args.isAborted()) return;
    // 三视图失败/缺失时不为该角色生成分镜：静默降级会导致跨分镜人物不一致（#814 决策 7）
    if (task.kind === "shot" && task.characterId && failedThreeviews.has(task.characterId)) {
      failed++;
      args.onTaskFailed(task, `角色 ${task.characterId} 的三视图缺失或失败：为避免人物不一致，本分镜未生成（请先重试该角色三视图）`);
      return;
    }
    try {
      const path = await runImageTask(args.cfg, task, args.cacheRoot, args.log, {
        outputDir: args.outputDir,
        figureBase,
        verifyCfg: args.verifyCfg,
        visionCfg: args.visionCfg,
        safeRewriteCfg: args.safeRewriteCfg,
        styleAnchorPath: args.styleAnchorPath ?? anchorPath,
        isAborted: args.isAborted,
        force: args.force === true,
      });
      if (!path) return;
      if (task.kind === "threeview") figureBase[task.id] = path;
      if (task.kind === "anchor") anchorPath = path;
      produced++;
      args.onTaskDone(task, path);
    } catch (e) {
      failed++;
      if (task.kind === "threeview" && task.characterId) failedThreeviews.add(task.characterId);
      args.onTaskFailed(task, errMsg(e).slice(0, 300));
    }
  };

  // 依赖分层：先锚点/三视图（后续任务的画风/identity 参考），再分镜/物品
  const first = args.tasks.filter((t) => t.kind === "anchor" || t.kind === "threeview");
  const rest = args.tasks.filter((t) => t.kind !== "anchor" && t.kind !== "threeview");
  await pool(first, args.concurrency, runOne);
  await pool(rest, args.concurrency, runOne);
  return { produced, failed };
}
