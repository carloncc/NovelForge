import type {
  ApiConfig,
  AssetMap,
  ChapterScript,
  ExtractionResult,
  GenerationOptions,
  ImageTask,
  StageKey,
} from "./types";
import { STAGE_ORDER } from "./types";
import { buildImageTasks } from "./images";
import { buildVoiceJobs } from "./voice";

/**
 * 单阶段重跑后的「下游自动补齐」判定（纯函数，无副作用）。
 *
 * 语义：只补**资产阶段**（图像/配音/组装）。分章/翻译/提取/剧本这类文本阶段永不自动跑——
 * 它们烧 LLM 费用且会重写全书，必须由用户显式点选。
 */

/** 可级联补齐的资产阶段集合；顺序与 STAGE_ORDER 一致 */
const ASSET_STAGE_SET = new Set<StageKey>(["image", "voice", "assemble"]);

export interface CascadeEnabled {
  /** 与 options.useImage 同源（界面同一个复选框） */
  image: boolean;
  /** 与 options.useTts 同源（界面同一个复选框） */
  voice: boolean;
  /** 组装是本地无计费操作，默认始终执行 */
  assemble?: boolean;
}

/**
 * 依据各阶段「是否已完成」（useStageStatus 的 base）算出本次要补齐的资产阶段。
 * - trigger：刚跑完的那个阶段，不参与级联，避免把同一阶段重复跑一遍又收一次费。
 * - 组装：本身免费且必须反映本轮新产物，所以「组装没跑过」或「本轮补了图像/配音」都要补上。
 */
export function missingAssetStages(
  completed: Record<StageKey, boolean>,
  enabled: CascadeEnabled,
  trigger?: StageKey,
): StageKey[] {
  const included = (stage: StageKey): boolean => ASSET_STAGE_SET.has(stage) && stage !== trigger;
  const image = included("image") && enabled.image && !completed.image;
  const voice = included("voice") && enabled.voice && !completed.voice;
  const out: StageKey[] = [];
  if (image) out.push("image");
  if (voice) out.push("voice");
  // 组装：游戏文件里已经写死了剧本正文与图片/配音路径，所以只要本轮动过剧本或资产，
  // 就算「组装」灯是绿的也得重跑一次，否则预览仍是旧的（组装为本地操作，不计费）。
  const touchedContent = image || voice || trigger === "script" || trigger === "image" || trigger === "voice";
  if (included("assemble") && enabled.assemble !== false && (!completed.assemble || touchedContent)) {
    out.push("assemble");
  }
  return out.sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b));
}

/**
 * 与 useStageStatus 同口径构建图像任务（单角色 1 张基础图，按 options 展开表情/动作/服装/三视图）。
 * 两处必须一致，否则看板绿灯与级联计数会打架。
 */
export function statusImageTasks(
  chapters: ChapterScript[],
  cards: ExtractionResult,
  options: GenerationOptions,
): ImageTask[] {
  return buildImageTasks(chapters, cards, {
    cgPerChapter: options.cgPerChapter ?? 0,
    maxPerChapter: options.imageBudgetPerChapter ?? 0,
    figureEmotions: options.figureEmotions,
    detail: options.figureDetail ?? "full",
    style: options.imageStyle,
    threeView: options.characterPoses !== false,
    actions: options.characterPoses !== false,
    styleAnchor: options.styleAnchor !== false,
  });
}

/** 任务是否已有产物；anchor 是画风基准，缺失不计入「未完成」（与看板口径一致） */
export function imageTaskHasAsset(task: ImageTask, assets: AssetMap | undefined): boolean {
  if (task.kind === "anchor") return true;
  if (!assets) return false;
  if (task.kind === "background") return Boolean(assets.bg[task.id]);
  if (task.kind === "cg") return Boolean(assets.cg[task.id]);
  if (task.kind === "item") return Boolean(assets.item[task.id]);
  return Boolean(assets.figure[task.id]);
}

/** 还缺多少张图（已命中的不计，用于级联前的费用确认） */
function missingImageTaskCount(
  chapters: ChapterScript[],
  cards: ExtractionResult,
  options: GenerationOptions,
  assets: AssetMap | undefined,
): number {
  return statusImageTasks(chapters, cards, options).filter((task) => !imageTaskHasAsset(task, assets)).length;
}

/** 还缺多少句配音（无 TTS 配置或未启用配音时为 0） */
function missingVoiceJobCount(
  tts: ApiConfig | undefined,
  chapters: ChapterScript[],
  cards: ExtractionResult,
  assets: AssetMap | undefined,
): number {
  if (!tts) return 0;
  return buildVoiceJobs(tts, chapters, cards.characters).filter((job) => !assets?.vocal[job.key]).length;
}

export interface CascadePlan {
  /** 本次要补齐的阶段（按 STAGE_ORDER 排序） */
  stages: StageKey[];
  /** 预计要生成的图片张数（仅统计图像阶段） */
  images: number;
  /** 预计要合成的配音句数（仅统计配音阶段） */
  voices: number;
}

/**
 * 汇总一次级联补齐计划：补齐哪些阶段 + 预计费用规模。
 * stages 为空表示下游没有缺失，不需要确认也不需要跑。
 */
export function planStageCascade(args: {
  completed: Record<StageKey, boolean>;
  enabled: CascadeEnabled;
  trigger?: StageKey;
  chapters: ChapterScript[];
  cards: ExtractionResult;
  options: GenerationOptions;
  assets: AssetMap | undefined;
  tts?: ApiConfig;
}): CascadePlan {
  const stages = missingAssetStages(args.completed, args.enabled, args.trigger);
  return {
    stages,
    images: stages.includes("image")
      ? missingImageTaskCount(args.chapters, args.cards, args.options, args.assets)
      : 0,
    voices: stages.includes("voice")
      ? missingVoiceJobCount(args.tts, args.chapters, args.cards, args.assets)
      : 0,
  };
}
