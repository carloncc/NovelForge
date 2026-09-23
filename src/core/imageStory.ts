/**
 * 图片小说（纯图片模式）图片通道（#806/#809/#810）：
 * - 任务构建：角色三视图（identity 参考，必须先行）＋ 每场景分镜（kind:"shot"）＋（可选）物品图；
 *   不产出立绘/表情/动作/服装差分，也不做抠图。
 * - 执行：按依赖分层（三视图 → 分镜/物品）并发执行，逐张回调结果供映射落盘；
 *   三视图失败的角色，其分镜不静默降级为纯文生图（#814 决策 7），直接记为失败并给出可执行提示。
 */
import type { ApiConfig, ChapterScript, ExtractionResult, ImageStoryOptions, ImageTask, PipelineEvent } from "./types";
import { buildImageTasks, runImageTask, shotCharacterIdsOf } from "./images";
import { errMsg } from "../utils/errors";

/** 每张图片的预估单价（元）：与 pipeline 的 DEFAULT_PRICES.imageYuanEach 同口径 */
export const IMAGE_YUAN_EACH = 0.3;

/**
 * 图片小说输出目录（纯函数，#1101）：与主项目同级的 `<书名>-图片版/`。
 * 无主项目目录时退化为相对名（由调用方保证 title 非空）。
 */
export function deriveImageStoryDir(mainOutputDir: string, title: string): string {
  const main = (mainOutputDir || "").replace(/[\\/]+$/, "");
  const name = (title || "未命名作品").replace(/\.txt$/i, "");
  if (!main) return `${name}-图片版`;
  const parent = main.includes("/") || main.includes("\\") ? main.replace(/[\\/][^\\/]*$/, "") : "";
  return `${parent ? `${parent}/` : ""}${name}-图片版`;
}

/** 图片小说目录绑定：记录该目录属于哪个主项目，用于「换作品不残留」（#1101） */
export interface ImageStoryDirLoadInput {
  /** 上次记录的目录（空=首次使用） */
  rememberedDir: string;
  /** 上次记录时是否自动跟随主项目（老版本记录没有该字段，按自动处理） */
  rememberedAuto: boolean;
  /** 按当前主项目推导出的目录 */
  derivedDir: string;
}

/** 载入时决定图片小说目录（纯函数）：自动跟随的目录一律按当前主项目重算，手动指定的目录保留不动 */
export function resolveImageStoryDirOnLoad(input: ImageStoryDirLoadInput): { dir: string; auto: boolean; followed: boolean } {
  if (!input.rememberedDir) return { dir: input.derivedDir, auto: true, followed: true };
  if (!input.rememberedAuto) return { dir: input.rememberedDir, auto: false, followed: false };
  return { dir: input.derivedDir, auto: true, followed: input.derivedDir !== input.rememberedDir };
}

/** 图片小说预估（纯函数，#1103）：无剧本时按「章节数 × 4 场景 × 每场景张数」粗估 */
export interface ImageStoryEstimate {
  total: number;
  yuan: number;
  exact: boolean;
  /** 三个张数旋钮都为 0（不限）：真实张数由剧本模型决定，文案必须提示「粗估」而不是「最多」 */
  unbounded: boolean;
}

export function estimateImageStoryPlan(
  chapterCount: number,
  options: Pick<ImageStoryOptions, "shotsPerScene" | "shotsPerChapter" | "shotsTotal" | "styleAnchor">,
  characterCount: number,
): ImageStoryEstimate {
  const chapters = Math.max(0, Math.floor(chapterCount));
  const perScene = options.shotsPerScene > 0 ? options.shotsPerScene : 2;
  const perChapter = options.shotsPerChapter > 0 ? options.shotsPerChapter : 0;
  let shots = perChapter > 0 ? Math.min(chapters * perChapter, chapters * 4 * perScene) : chapters * 4 * perScene;
  // #1325/#1371：粗估与执行同口径——总张数上限封顶（buildImageTasks 到量即停，见 images.ts）。
  if (options.shotsTotal > 0) shots = Math.min(shots, options.shotsTotal);
  // #1340：imageOnly 下不生成风格锚点（buildImageStoryPlan 强制关闭），粗估也不计入锚点费用。
  const total = shots + Math.max(0, Math.floor(characterCount));
  return {
    total,
    yuan: Math.round(total * IMAGE_YUAN_EACH * 100) / 100,
    exact: false,
    unbounded: options.shotsPerScene <= 0 && options.shotsPerChapter <= 0 && options.shotsTotal <= 0,
  };
}

/** 分镜触发行号兜底记录（#1134）：供日志/核对报告标注「触发行号由系统兜底」 */
export interface ShotTriggerRepair {
  chapter: number;
  sceneId: string;
  before: number[];
  after: number[];
}

/**
 * 分镜触发行号归一化（纯函数，#1134）：
 * 模型漏写 triggerLineIndex（脚本归一化默认 0）或多次写同一行时，多张分镜会堆在一句之前，
 * 玩家实际只能看到最后一张。这里对「缺失/重复/非递增/越界」的场景按
 * floor((k+1)*lines/(n+1)) 均匀铺开（与 itemEvents 同思路），保证每张分镜都参与演出。
 */
export function normalizeShotTriggers(chapters: ChapterScript[]): { chapters: ChapterScript[]; repairs: ShotTriggerRepair[] } {
  const repairs: ShotTriggerRepair[] = [];
  const out = chapters.map((chapter) => ({
    ...chapter,
    scenes: chapter.scenes.map((scene) => {
      const shots = scene.shots ?? [];
      const lineCount = scene.lines.length;
      if (shots.length < 2 || !lineCount) return scene;
      const raw = shots.map((s) => Number(s.triggerLineIndex));
      const maxIndex = lineCount - 1;
      const valid = raw.every((v, i) => Number.isFinite(v) && v >= 0 && v <= maxIndex && (i === 0 || v > raw[i - 1]));
      if (valid) return scene;
      const before = raw.map((v) => (Number.isFinite(v) ? Math.floor(v) : 0));
      const after = shots.map((_, k) => Math.floor(((k + 1) * lineCount) / (shots.length + 1)));
      repairs.push({ chapter: chapter.chapter, sceneId: scene.id, before, after });
      return { ...scene, shots: shots.map((s, k) => ({ ...s, triggerLineIndex: after[k] })) };
    }),
  }));
  return { chapters: out, repairs };
}

/** 组装前章节连续性计划（#1111/#1132） */
export interface ChapterContinuityPlan {
  ok: boolean;
  /** 本次已拿到剧本的原始章号（升序） */
  present: number[];
  /** 缺失的启用章原始章号（升序） */
  missing: number[];
  /** 重编号后的章节（chapter 连续 0..n-1；与主链路 pipeline 同口径） */
  renumbered: ChapterScript[];
}

/**
 * 组装前章节连续性校验 + 重编号（纯函数）：
 * - 缺任一启用章 → ok=false，调用方必须阻断组装（否则 chN 指向不存在的 chN+1，开局/中途断链）；
 * - 全部齐备 → 按原始章号升序重编号为 0..n-1，停用中间章也不会留下空洞。
 */
export function planChapterContinuity(chapters: ChapterScript[], expectedChapterIndexes: number[]): ChapterContinuityPlan {
  const expected = [...new Set(expectedChapterIndexes)].sort((a, b) => a - b);
  const sorted = [...chapters].sort((a, b) => a.chapter - b.chapter);
  const present = sorted.map((c) => c.chapter);
  const have = new Set(present);
  const missing = expected.filter((i) => !have.has(i));
  return {
    ok: missing.length === 0,
    present,
    missing,
    renumbered: sorted.map((c, i) => (c.chapter === i ? c : { ...c, chapter: i })),
  };
}

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
    // #1340：imageOnly 下风格锚点是死开关（shot 任务既不拼锚点提示词也不挂锚点参考图，
    // 且 images.ts 的锚点只服务 background/cg）——强制关闭，不生成不计费；页面同步标注。
    styleAnchor: false,
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
  /** 预置的参考图映射（键为任务 id，如 `<角色id>_threeview`）：单张重生成时复用已生成的三视图 */
  figureBase?: Record<string, string>;
}

/** 执行图片小说任务：三视图先行，随后分镜/物品；返回成功与失败计数（中断时未派发的不计失败） */
export async function runImageStoryTasks(args: ImageStoryRunArgs): Promise<{ produced: number; failed: number }> {
  // 预置映射（单张重生成）优先：三视图任务完成后写入的路径会覆盖同名键
  const figureBase: Record<string, string> = { ...(args.figureBase ?? {}) };
  const failedThreeviews = new Set<string>();
  let produced = 0;
  let failed = 0;
  /** 风格锚点产物路径：锚点任务完成后作为无角色分镜的画风参考（有 identity 参考的任务不吃锚点） */
  let anchorPath: string | undefined;

  const runOne = async (task: ImageTask): Promise<void> => {
    if (args.isAborted()) return;
    // 三视图失败/缺失时不为该角色生成分镜：静默降级会导致跨分镜人物不一致（#814 决策 7）。
    // #1133：守卫对分镜的每个出场角色生效——第二、第三个角色的三视图失败同样不生成、不付费。
    if (task.kind === "shot") {
      const missing = shotCharacterIdsOf(task).filter((id) => failedThreeviews.has(id) || !figureBase[`${id}_threeview`]);
      if (missing.length) {
        failed++;
        args.onTaskFailed(task, `角色 ${missing.join("、")} 的三视图缺失或失败：为避免人物不一致，本分镜未生成（请先重试这些角色的三视图）`);
        return;
      }
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
