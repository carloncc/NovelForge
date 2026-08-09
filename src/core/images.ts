import type {
  ChapterScript,
  CharacterCard,
  ExtractionResult,
  FailedTask,
  ImageReference,
  ImageTask,
  ItemCard,
  MaterialAsset,
  PipelineEvent,
  SceneJSON,
  ProjectVisualBible,
  VisualBibleCacheBinding,
} from "./types";
import type { ApiConfig } from "./types";
import { generateImage, ReferenceImageError, VisionApiError } from "../api/openaiCompatible";
import { resolveImageModelCapabilities } from "../api/providers";
import { verifyImage } from "./selfcheck";
import { tauri } from "../utils/tauri";
import { errMsg } from "../utils/errors";
import { cacheDirFor, cacheHit } from "./cache";
import { sanitizeId } from "./render";
import { log as logger } from "../utils/logger";

export interface ImageResultMap {
  bg: Record<string, string>;
  cg: Record<string, string>;
  figure: Record<string, string>;
  item: Record<string, string>;
}

function nameContains(name: string, keywords: string[]): boolean {
  return keywords.some((k) => k && name.includes(k));
}

const FIGURE_EMOTIONS = ["normal", "happy", "sad", "angry", "surprised"];

const EMOTION_PROMPT_SUFFIX: Record<string, string> = {
  normal: "",
  happy: ", smiling joyfully with bright expression",
  sad: ", sad sorrowful expression, eyes downcast",
  angry: ", angry fierce expression, glaring eyes",
  surprised: ", shocked surprised expression, wide eyes",
};

// 立绘/物品强制纯色背景：AI 无法输出透明 PNG，统一生成纯绿底（绿幕），管线再色度键抠图（透明立绘）
const FIGURE_BG_SUFFIX =
  ", pure solid green chroma background (exact RGB 0,255,0), even flat green screen filling entire background, no shadow, no gradient, no pattern, no other objects, no text, full body visible, no legs cut off";
const ITEM_BG_SUFFIX = ", pure solid green chroma background (exact RGB 0,255,0), even flat green screen, no shadow, no reflection, no text";

// 统一画风：保证同一项目内所有立绘/背景/CG 视觉风格一致（同一个“维度”）
const DEFAULT_STYLE =
  "unified Japanese anime style, cel shading, clean line art, consistent character design and proportions, cohesive color palette, high quality illustration";
const STYLE_HINT = "consistent art direction, same visual style, no dimension change";

// 统一负面提示词：避免低质量/畸形/水印等破坏画风与观感的元素
const DEFAULT_NEGATIVE =
  "lowres, bad anatomy, bad hands, extra fingers, mutated hands, deformed, disfigured, missing fingers, extra digit, watermark, signature, text, logo, jpeg artifacts, blurry, noise, low quality, worst quality";

// 风格锚点：一张纯场景/无人物的画风基准图，后续所有背景/CG 以它做参考图，强制全项目同一画风
const ANCHOR_PROMPT =
  "anime background scenery, a serene countryside valley at golden hour with distant mountains and a small village, soft lighting, cinematic wide shot, no people, no text";

/** 图生图一致性提示：要求与参考图保持同一角色/服装/配色/画风/维度 */
const REF_HINT =
  ", exactly match the reference image: same character, same hair and eye color, same clothing and colors, same art style, same proportions, front-facing full body";

/** 三视图基于角色参考图生成：以参考图为基准，输出正/侧/背三视图设定图 */
const THREEVIEW_REF_HINT =
  ", based on the reference image: keep the exact same character (hair, eyes, clothing, colors, proportions, art style), generate a clean three-view character sheet (front view / side view / back view), neutral standing pose, calm expression, full body visible, plain white background";

/** 背景/CG 风格锚定提示：参考图为画风基准，内容必须全新 */
const STYLE_ANCHOR_HINT =
  ", same exact art style, line rendering, color palette, lighting and texture quality as the reference image, but an entirely different scene with different content";

function inlineIdentityReference(rawImage: string): ImageReference {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(rawImage.trim());
  return {
    role: "identity",
    dataB64: rawImage,
    mime: match?.[1] ?? "image/png",
    required: true,
  };
}

function styleSuffix(style?: string): string {
  const s = (style ?? "").trim();
  if (!s) return `, ${DEFAULT_STYLE}`;
  return `, ${s.replace(/[,，。.]+$/, "")}, ${STYLE_HINT}`;
}

/** 从立绘 prompt 兜底推导三视图 prompt（无 threeViewPrompt 时用） */
function threeViewFallback(imagePrompt: string): string {
  const clean = (imagePrompt || "")
    .replace(/standing pose[^,]*/gi, "")
    .replace(/plain white background[^,]*/gi, "")
    .replace(/clean illustration[^,]*/gi, "")
    .replace(/[,，\s]+$/, "");
  return `${clean}, three-view character reference sheet, front view / side view / back view, neutral standing pose, calm expression, full body visible, plain white background`;
}

export interface BuildImageTaskOptions {
  figurePerCharacter?: number;
  cgPerChapter?: number;
  maxPerChapter?: number;
  figureEmotions?: boolean;
  style?: string;
  feedback?: string;
  /** 生成角色三视图（作后续立绘/表情/动作的图生图参考） */
  threeView?: boolean;
  /** 基于三视图生成角色动作立绘 */
  actions?: boolean;
  /** 确定性种子基数：为每个任务分配 baseSeed+i 的固定种子（同一项目重跑结果稳定） */
  baseSeed?: number;
  /** 风格锚点：先生成画风基准图，背景/CG 以其为参考图统一画风 */
  styleAnchor?: boolean;
}

export function buildImageTasks(
  chapters: ChapterScript[],
  cards: ExtractionResult,
  opts: BuildImageTaskOptions = {},
): ImageTask[] {
  const tasks: ImageTask[] = [];
  const figurePerCharacter = opts.figurePerCharacter ?? 1;
  const cgPerChapter = opts.cgPerChapter ?? 3;
  const maxPerChapter = opts.maxPerChapter ?? 12;
  const useEmotions = opts.figureEmotions !== false;
  const threeView = opts.threeView !== false;
  const withActions = opts.actions !== false;
  const baseStyle = styleSuffix(opts.style);
  const style = opts.feedback ? `${baseStyle}, ${opts.feedback.trim().replace(/[。.]$/, "")}` : baseStyle;
  const useAnchor = opts.styleAnchor !== false;

  // ① 全项目画风锚点：一张无人物场景基准图，作为所有背景/CG 的画风参考
  if (useAnchor) {
    tasks.push({
      kind: "anchor",
      id: "__anchor__",
      prompt: ANCHOR_PROMPT + style,
      fileName: "anchor_style.png",
      width: 1024,
      height: 576,
      usage: "风格锚点（画风基准）",
    });
  }

  for (const char of cards.characters) {
    // ① 三视图参考图（正/侧/背），作为该角色所有图像的图生图基准；
    //    若用户为角色设置了参考图，则以参考图为基准生成三视图（保持人物一致）
    if (threeView) {
      tasks.push({
        kind: "threeview",
        id: `${char.id}_threeview`,
        characterId: char.id,
        prompt:
          (char.threeViewPrompt || threeViewFallback(char.imagePrompt)) +
          style +
          (char.referenceImage ? THREEVIEW_REF_HINT : ""),
        ...(char.referenceImage ? { references: [inlineIdentityReference(char.referenceImage)] } : {}),
        fileName: `threeview_${sanitizeId(char.id)}.png`,
        width: 1024,
        height: 1024,
        usage: `三视图-${char.name}`,
      });
    }
    // ② 立绘（默认姿态）→ 以三视图为参考图
    const emotions = useEmotions ? FIGURE_EMOTIONS : ["normal"];
    for (const emo of emotions) {
      const isNormal = emo === "normal";
      tasks.push({
        kind: "figure",
        id: isNormal ? char.id : `${char.id}_${emo}`,
        characterId: char.id,
        emotion: emo,
        prompt: char.imagePrompt + (EMOTION_PROMPT_SUFFIX[emo] ?? "") + REF_HINT + style + FIGURE_BG_SUFFIX,
        refFromTask: isNormal ? (threeView ? `${char.id}_threeview` : undefined) : char.id,
        fileName: `figure_${sanitizeId(char.id)}_${emo}.png`,
        width: 1024,
        height: 1024,
        usage: `立绘-${char.name}${isNormal ? "" : `（${emo}）`}`,
      });
    }
    // ③ 动作立绘（基于三视图图生图）
    if (threeView && withActions && Array.isArray(char.actions)) {
      for (const a of char.actions.slice(0, 4)) {
        tasks.push({
          kind: "action",
          id: `${char.id}_act_${a.id}`,
          characterId: char.id,
          actionId: a.id,
          prompt: a.prompt + REF_HINT + style + FIGURE_BG_SUFFIX,
          refFromTask: `${char.id}_threeview`,
          fileName: `figure_${sanitizeId(char.id)}_act_${sanitizeId(a.id)}.png`,
          width: 1024,
          height: 1024,
          usage: `动作-${char.name}-${a.name}`,
        });
      }
    }
  }

  for (const item of cards.items) {
    tasks.push({
      kind: "item",
      id: item.id,
      prompt: item.imagePrompt + style + ITEM_BG_SUFFIX,
      fileName: `item_${sanitizeId(item.id)}.png`,
      width: 1024,
      height: 1024,
      usage: `物品-${item.name}`,
    });
  }

  for (const chapter of chapters) {
    let count = 0;
    for (const scene of chapter.scenes) {
      if (count >= maxPerChapter) break;
      tasks.push({
        kind: "background",
        id: scene.id,
        prompt: (scene.bgPrompt || `${scene.location} ${scene.atmosphere}, anime background, no people`) + style + (useAnchor ? STYLE_ANCHOR_HINT : ""),
        fileName: `bg_${sanitizeId(scene.id)}.png`,
        width: 1024,
        height: 576,
        usage: `背景-${scene.location}`,
      });
      count++;
    }
    let cgCount = 0;
    for (const scene of chapter.scenes) {
      if (cgCount >= cgPerChapter) break;
      if (scene.cgEvent) {
        tasks.push({
          kind: "cg",
          id: `${chapter.chapter}_${scene.id}`,
          prompt: scene.cgEvent.imagePrompt + style + (useAnchor ? STYLE_ANCHOR_HINT : ""),
          fileName: `cg_${chapter.chapter}_${sanitizeId(scene.id)}.png`,
          width: 1024,
          height: 576,
          usage: `CG-${scene.cgEvent.title}`,
        });
        cgCount++;
      }
    }
  }

  // 确定性种子：baseSeed 已指定时，按任务顺序分配固定种子（锚点=baseSeed，其余依次 +1）
  if (opts.baseSeed !== undefined) {
    tasks.forEach((t, i) => {
      t.seed = opts.baseSeed! + i;
    });
  }

  return tasks;
}

async function copyMaterial(mat: MaterialAsset, targetPath: string): Promise<void> {
  if (!(await tauri.pathExists(mat.path).catch(() => false))) {
    throw new ReferenceImageError(`Declared material is missing: ${mat.path}`, "REFERENCE_MISSING");
  }
  try {
    await tauri.copyFile(mat.path, targetPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ReferenceImageError(`Declared material could not be copied: ${mat.path} (${reason})`, "REFERENCE_MISSING");
  }
}

async function ensureCutout(
  path: string,
  task: ImageTask,
  log: (ev: PipelineEvent) => void,
): Promise<string> {
  try {
    const b64 = await tauri.readFileBase64(path);
    if (await tauri.hasTransparency(b64)) return path;
    const res = await tauri.cutoutImage(b64, 40);
    const out = res.dataB64;
    const pngPath = path.replace(/\.(jpg|jpeg)$/i, ".png");
    await tauri.writeFileBase64(pngPath, out);
    if (pngPath !== path) {
      await tauri.removePath(path).catch(() => {});
    }
    const method = res.method === "ai" ? "AI 抠图" : "色度键抠图";
    log({ step: "图像", message: `无背景立绘（${method}）：${task.usage}`, level: "info", at: Date.now() });
    return pngPath;
  } catch (e) {
    log({
      step: "图像",
      message: `抠图失败，保留原图：${task.usage}（${errMsg(e).slice(0, 100)}）`,
      level: "warn",
      at: Date.now(),
    });
    return path;
  }
}

export interface ImageRunOptions {
  materials?: MaterialAsset[];
  /** 跳过缓存强制重生成（会覆盖同一文件名的缓存文件） */
  force?: boolean;
  /** 表情差分参考图：normal 立绘路径（单素材重生成时传入） */
  figureBase?: Record<string, string>;
  /** Approved project references. File reads are resolved immediately before an API request. */
  visualBible?: ProjectVisualBible;
  outputDir?: string;
  /** 多模态模型自检：生成后核对图片是否符合描述，不合格自动重生成 1 次 */
  verifyCfg?: ApiConfig;
  /** 风格锚点图路径：背景/CG 以其为参考图统一画风（仅当任务无其它参考图时生效） */
  styleAnchorPath?: string;
  /** 负面提示词（走适配器模板 $negativePrompt，模板未映射则忽略） */
  negativePrompt?: string;
}

export interface ImageReferenceResolutionContext {
  outputDir: string;
  visualBible?: ProjectVisualBible;
  figureBase?: Record<string, string>;
  styleAnchorPath?: string;
}

function imageMimeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

async function fileReference(
  path: string,
  role: ImageReference["role"],
  label: string,
  required = true,
): Promise<ImageReference> {
  if (!(await tauri.pathExists(path).catch(() => false))) {
    throw new ReferenceImageError(`${label} is missing: ${path}`, "REFERENCE_MISSING");
  }
  try {
    const dataB64 = await tauri.readFileBase64(path);
    if (!dataB64.trim()) throw new Error("empty file");
    return { role, dataB64, mime: imageMimeForPath(path), sourcePath: path, required };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ReferenceImageError(`${label} could not be read: ${path} (${message})`, "REFERENCE_MISSING");
  }
}

function visualBibleArtifactPath(outputDir: string, storedPath: string): string {
  return `${outputDir.replace(/[\\/]$/, "").replace(/\\/g, "/")}/.novel2vn/visual-bible/${storedPath}`;
}

export async function resolveImageTaskReferences(
  task: ImageTask,
  context: ImageReferenceResolutionContext,
): Promise<ImageReference[]> {
  const references = [...(task.references ?? [])];
  const bible = context.visualBible?.status === "approved" ? context.visualBible : undefined;
  const bibleCharacter = task.characterId ? bible?.characters[task.characterId] : undefined;
  const characterDerivative = task.kind === "figure" || task.kind === "action";

  if (task.refFromTask) {
    const generatedPath = context.figureBase?.[task.refFromTask];
    if (generatedPath) {
      references.unshift(await fileReference(generatedPath, "identity", `Generated identity for ${task.id}`));
    } else if (bibleCharacter) {
      const storedPath = bibleCharacter.threeViewPath;
      references.unshift(await fileReference(
        visualBibleArtifactPath(context.outputDir, storedPath),
        "identity",
        `Approved identity for ${task.characterId}`,
      ));
    } else {
      throw new ReferenceImageError(`Required generated reference ${task.refFromTask} is unavailable for ${task.id}`, "REFERENCE_MISSING");
    }
  } else if (characterDerivative && bibleCharacter) {
    references.unshift(await fileReference(
      visualBibleArtifactPath(context.outputDir, bibleCharacter.threeViewPath),
      "identity",
      `Approved identity for ${task.characterId}`,
    ));
  } else if (task.kind === "threeview" && bibleCharacter && !references.some((reference) => reference.role === "identity")) {
    const storedPath = bibleCharacter.sourceReferencePath ?? bibleCharacter.threeViewPath;
    references.unshift(await fileReference(
      visualBibleArtifactPath(context.outputDir, storedPath),
      "identity",
      `Character source for ${task.characterId}`,
    ));
  }

  if (bible) {
    const styleRequired = !references.some((reference) => reference.role === "identity");
    references.push(await fileReference(
      visualBibleArtifactPath(context.outputDir, bible.styleReferencePath),
      "style",
      "Approved global style reference",
      styleRequired,
    ));
  } else if ((task.kind === "background" || task.kind === "cg") && context.styleAnchorPath) {
    references.push(await fileReference(context.styleAnchorPath, "style", "Legacy style anchor"));
  }
  return references;
}

/** 执行单个图像任务（管线批处理与单素材重生成共用） */
export async function runImageTask(
  cfg: ApiConfig | undefined,
  task: ImageTask,
  cacheRoot: string,
  log: (ev: PipelineEvent) => void,
  opts: ImageRunOptions = {},
): Promise<string | null> {
  const cacheDir = cacheDirFor(cacheRoot, "images");
  await tauri.mkdirAll(cacheDir);
  let path: string | null = null;
  let source = "";
  let resolvedReferences: ImageReference[] = [];
  let materialReference: ImageReference | undefined;

  const cached = opts.force ? null : await cacheHit(cacheDir, task.fileName);
  if (cached) {
    path = cached;
    source = "缓存";
    logger.debug("images", "图像命中缓存", { id: task.id, fileName: task.fileName });
  } else {
    const mat = findMaterial(opts.materials ?? [], task);
    if (mat) {
      const useAsItemReference = !!cfg && task.kind === "item" && opts.visualBible?.status === "approved";
      if (useAsItemReference) {
        const resolvedMaterial = await fileReference(mat.path, "identity", `Item material for ${task.id}`);
        materialReference = {
          ...resolvedMaterial,
          mime: mat.mime.startsWith("image/") ? mat.mime : resolvedMaterial.mime,
        };
      } else {
        await copyMaterial(mat, `${cacheDir}/${task.fileName}`);
        path = `${cacheDir}/${task.fileName}`;
        source = `用户素材 ${mat.name}`;
      }
    }
    if (!path) {
      log({ step: "图像", message: `生成中：${task.usage}`, level: "info", at: Date.now() });
      if (!cfg) {
        log({
          step: "图像",
          message: `未配置图像 API，跳过：${task.usage}（可先在「API 配置」页添加）`,
          level: "warn",
          at: Date.now(),
        });
        return null;
      }
      const generationTask = materialReference
        ? { ...task, references: [materialReference, ...(task.references ?? [])] }
        : task;
      resolvedReferences = await resolveImageTaskReferences(generationTask, {
        outputDir: opts.outputDir ?? cacheRoot.replace(/[\\/]\.novel2vn[\\/]cache[\\/]?$/, ""),
        visualBible: opts.visualBible,
        figureBase: opts.figureBase,
        styleAnchorPath: opts.styleAnchorPath,
      });
      const capabilities = resolveImageModelCapabilities(cfg);
      if (capabilities.maxReferenceImages === 1
        && resolvedReferences.some((reference) => reference.role === "identity")
        && resolvedReferences.some((reference) => reference.role === "style" && reference.required === false)) {
        log({
          step: "图像",
          message: `模型仅支持单参考图：${task.usage} 使用已批准的人物身份图，画风由已批准的风格文字约束`,
          level: "info",
          at: Date.now(),
        });
      }
      const img = await generateImage(cfg, task.prompt, {
        references: resolvedReferences,
        size: `${task.width}x${task.height}`,
        seed: task.seed,
        negativePrompt: opts.negativePrompt,
      });
      const ext = img.mime.includes("jpeg") ? "jpg" : "png";
      const file = task.fileName.replace(/\.png$/, `.${ext}`);
      path = `${cacheDir}/${file}`;
      await tauri.writeFileBase64(path, img.dataB64);
      source = "AI 生成";
    }
  }

  // 立绘/动作/物品图自动抠出无背景透明底（失败自动降级保留原图）；三视图保留原样
  if (path && (task.kind === "figure" || task.kind === "action" || task.kind === "item")) {
    path = await ensureCutout(path, task, log);
  }

  // 多模态自检：核对图片是否符合描述，不合格自动重生成 1 次（有参考图时一并核对角色/画风一致性）
  if (path && opts.verifyCfg && source === "AI 生成") {
    try {
      const b64 = await tauri.readFileBase64(path);
      const { ok, reason } = await verifyImage(
        opts.verifyCfg,
        b64,
        `${task.usage}；${task.prompt}`,
        { references: resolvedReferences },
      );
      if (!ok) {
        log({ step: "图像", message: `自检未通过（自动重生成 1 次）：${task.usage}（${reason}）`, level: "warn", at: Date.now() });
        const fixed = await runImageTask(cfg, { ...task, prompt: `${task.prompt}, IMPORTANT FIX: ${reason}` }, cacheRoot, log, {
          ...opts,
          force: true,
          verifyCfg: undefined,
        });
        if (fixed) {
          path = fixed;
          source = "AI 生成（自检重生成）";
        } else {
          log({ step: "图像", message: `自检重生成失败，保留原图：${task.usage}`, level: "warn", at: Date.now() });
        }
      }
    } catch (e) {
      if (e instanceof VisionApiError) throw e;
      log({ step: "图像", message: `自检过程出错（保留原图）：${task.usage}（${errMsg(e).slice(0, 120)}）`, level: "warn", at: Date.now() });
    }
  }

  if (path) {
    const prefix = source === "缓存" ? "[缓存] " : source.startsWith("用户素材") ? `[用户素材] ` : "";
    log({ step: "图像", message: `${prefix}${task.usage}${source.startsWith("用户素材") ? ` <- ${source.replace("用户素材 ", "")}` : ""}`, level: "success", at: Date.now() });
    logger.debug("images", "图像任务完成", { id: task.id, kind: task.kind, usage: task.usage, source, path });
  }
  return path;
}

export async function generateImages(
  cfg: ApiConfig | undefined,
  chapters: ChapterScript[],
  cards: ExtractionResult,
  materials: MaterialAsset[],
  cacheRoot: string,
  log: (ev: PipelineEvent) => void,
  concurrency = 2,
  figureEmotions = true,
  style?: string,
  feedback?: string,
  force = false,
  threeView = true,
  withActions = true,
  verifyCfg?: ApiConfig,
  baseSeed?: number,
  styleAnchor = true,
  isAborted?: () => boolean,
  visualBible?: ProjectVisualBible,
): Promise<{ images: ImageResultMap; failed: FailedTask[] }> {
  const result: ImageResultMap = { bg: {}, cg: {}, figure: {}, item: {} };
  const failed: FailedTask[] = [];
  const approvedBible = visualBible?.status === "approved" ? visualBible : undefined;
  const projectOutputDir = cacheRoot.replace(/[\\/]\.novel2vn[\\/]cache[\\/]?$/, "");
  const tasks = buildImageTasks(chapters, cards, {
    figurePerCharacter: 1,
    cgPerChapter: 3,
    maxPerChapter: 12,
    figureEmotions,
    style: approvedBible?.styleDescription ?? style,
    feedback,
    threeView,
    actions: withActions,
    baseSeed,
    styleAnchor: approvedBible ? false : styleAnchor,
  });

  await tauri.mkdirAll(cacheDirFor(cacheRoot, "images"));
  const visualBibleCacheMarker = `${cacheDirFor(cacheRoot, "images")}/.visual-bible-fingerprint`;
  const approvedCacheBinding = approvedBible ? cacheBindingForBible(approvedBible) : undefined;
  const storedCacheBinding = approvedBible
    ? await readCacheBinding(visualBibleCacheMarker, approvedBible, approvedCacheBinding!)
    : undefined;
  const globalCacheCurrent = !approvedBible
    || storedCacheBinding?.globalFingerprint === approvedCacheBinding?.globalFingerprint;
  const imageForceFor = (task: ImageTask): boolean => {
    if (force || !globalCacheCurrent) return true;
    if (!task.characterId || !approvedCacheBinding) return false;
    return storedCacheBinding?.characterRevisions[task.characterId]
      !== approvedCacheBinding.characterRevisions[task.characterId];
  };
  logger.info("images", "开始生成图像素材", {
    totalTasks: tasks.length,
    anchor: tasks.filter((t) => t.kind === "anchor").length,
    threeview: tasks.filter((t) => t.kind === "threeview").length,
    action: tasks.filter((t) => t.kind === "action").length,
    bg: tasks.filter((t) => t.kind === "background").length,
    cg: tasks.filter((t) => t.kind === "cg").length,
    figure: tasks.filter((t) => t.kind === "figure").length,
    item: tasks.filter((t) => t.kind === "item").length,
    cfg: !!cfg,
    figureEmotions,
    threeView,
    force,
    baseSeed,
    styleAnchor,
    hasFeedback: !!feedback,
    style: style ? style.slice(0, 80) : "(默认)",
    concurrency,
  });

  // 实时进度：total 为任务总数，done 为已完成（含缓存/失败）；每个任务完成后发一条进度事件
  const total = tasks.length;
  let done = 0;
  const emitProgress = (task: ImageTask, extra = ""): void => {
    done++;
    const label = (task.usage ?? task.fileName) + extra;
    log({
      step: "图像",
      message: `进度 ${done}/${total}：${label}`,
      level: "info",
      at: Date.now(),
      progress: { done, total, label },
    });
  };

  // 五阶段执行（链式图生图保证形象/画风一致）：
  // 风格锚点 → 三视图 → 默认立绘+背景/CG/物品（背景/CG 以锚点为参考）→ 表情差分（以默认立绘为参考）→ 动作（以三视图为参考）
  const leadingPass = tasks.filter((t) => t.kind === "threeview");
  // 默认立绘的 emotion 为 "normal"，必须归入首轮，否则表情差分没有参考图（曾导致角色形象漂移）
  const firstPass = tasks.filter(
    (t) => (t.kind === "figure" && (!t.emotion || t.emotion === "normal")) || t.kind === "background" || t.kind === "cg" || t.kind === "item",
  );
  const emotionPass = tasks.filter((t) => t.kind === "figure" && t.emotion && t.emotion !== "normal");
  const actionPass = tasks.filter((t) => t.kind === "action");

  const record = (task: ImageTask, path: string) => {
    switch (task.kind) {
      case "background": result.bg[task.id] = path; break;
      case "cg": result.cg[task.id] = path; break;
      case "figure": result.figure[task.id] = path; break;
      case "threeview": result.figure[task.id] = path; break;
      case "action": result.figure[task.id] = path; break;
      case "item": result.item[task.id] = path; break;
      case "anchor": break;
    }
  };

  const runPass = async (pass: ImageTask[], anchorPath?: string) => {
    let idx = 0;
    const worker = async () => {
      while (idx < pass.length) {
        if (isAborted?.()) return;
        const task = pass[idx++];
        try {
          const p = await runImageTask(cfg, task, cacheRoot, log, {
            materials,
            force: imageForceFor(task),
            figureBase: result.figure,
            visualBible: approvedBible,
            outputDir: projectOutputDir,
            verifyCfg,
            styleAnchorPath: anchorPath,
            negativePrompt: DEFAULT_NEGATIVE,
          });
          emitProgress(task);
          if (p) record(task, p);
        } catch (e) {
          if (e instanceof VisionApiError) throw e;
          emitProgress(task, "（失败）");
          // 单任务失败不阻断整章：记录并继续
          failed.push({
            id: task.id,
            kind: "image",
            step: "图像",
            message: `${task.usage}：${errMsg(e).slice(0, 140)}`,
            at: Date.now(),
          });
          log({
            step: "图像",
            message: `失败（已跳过，可在「失败项」重试）：${task.usage}（${(e as Error).message.slice(0, 100)}）`,
            level: "error",
            at: Date.now(),
            taskId: task.id,
            taskKind: "image",
          });
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  };

  // 风格锚点先生成，供背景/CG 引用
  let anchorPath: string | undefined;
  const anchorTask = tasks.find((t) => t.kind === "anchor");
  if (anchorTask) {
    const p = await runImageTask(cfg, anchorTask, cacheRoot, log, {
      materials,
      force: imageForceFor(anchorTask),
      figureBase: result.figure,
      visualBible: approvedBible,
      outputDir: projectOutputDir,
      verifyCfg,
      negativePrompt: DEFAULT_NEGATIVE,
    });
    emitProgress(anchorTask);
    if (p) anchorPath = p;
  }
  if (isAborted?.()) {
    log({ step: "图像", message: "已中止（后续图片任务不再继续，已生成的保留）", level: "warn", at: Date.now() });
  } else {
    await runPass(leadingPass, anchorPath);
    await runPass(firstPass, anchorPath);
    await runPass(emotionPass, anchorPath);
    await runPass(actionPass, anchorPath);
  }

  for (const chapter of chapters) {
    for (const scene of chapter.scenes) {
      scene.chapterOf = chapter.chapter;
      const bg = result.bg[scene.id];
      if (bg) scene.bgFile = bg;
      const cg = result.cg[`${chapter.chapter}_${scene.id}`];
      if (cg) scene.cgFile = cg;
    }
  }

  logger.info("images", "图像素材生成完成", {
    bg: Object.keys(result.bg).length,
    cg: Object.keys(result.cg).length,
    figure: Object.keys(result.figure).length,
    item: Object.keys(result.item).length,
    failed: failed.length,
  });

  if (approvedBible && cfg && failed.length === 0 && !isAborted?.()) {
    await tauri.writeTextFile(visualBibleCacheMarker, JSON.stringify(approvedCacheBinding));
  }

  return { images: result, failed };
}

function cacheBindingForBible(bible: ProjectVisualBible): VisualBibleCacheBinding {
  const characterRevisions = Object.fromEntries(
    Object.entries(bible.characters).map(([characterId, character]) => [characterId, character.revision]),
  );
  const existingBinding = bible.cacheBinding;
  if (existingBinding
    && Object.keys(characterRevisions).every((characterId) => Number.isInteger(existingBinding.characterRevisions[characterId]))) {
    return existingBinding;
  }
  return {
    globalFingerprint: existingBinding?.globalFingerprint ?? bible.inputFingerprint,
    characterRevisions,
  };
}

async function readCacheBinding(
  markerPath: string,
  bible: ProjectVisualBible,
  currentBinding: VisualBibleCacheBinding,
): Promise<VisualBibleCacheBinding | undefined> {
  try {
    const marker = (await tauri.readTextFile(markerPath)).text.trim();
    if (marker === bible.inputFingerprint || marker === currentBinding.globalFingerprint) {
      return {
        globalFingerprint: currentBinding.globalFingerprint,
        characterRevisions: { ...currentBinding.characterRevisions },
      };
    }
    const parsed = JSON.parse(marker) as Partial<VisualBibleCacheBinding>;
    if (typeof parsed.globalFingerprint !== "string"
      || !parsed.characterRevisions
      || typeof parsed.characterRevisions !== "object") return undefined;
    return {
      globalFingerprint: parsed.globalFingerprint,
      characterRevisions: Object.fromEntries(
        Object.entries(parsed.characterRevisions).filter(([, revision]) => Number.isInteger(revision) && revision >= 0),
      ) as Record<string, number>,
    };
  } catch {
    return undefined;
  }
}

function findMaterial(materials: MaterialAsset[], task: ImageTask): MaterialAsset | undefined {
  // 表情差分任务不匹配用户素材（用 normal 立绘做参考图保证一致性）
  if (task.kind === "figure" && task.emotion && task.emotion !== "normal") return undefined;
  // 优先精确映射（用户手动指定该素材用于哪个角色/物品）
  const mapped = materials.find((m) => m.extra?.mapTo === task.id);
  if (mapped) return mapped;

  let keywords: string[] = [];
  const usage = task.usage ?? "";
  switch (task.kind) {
    case "figure": keywords = [task.id, usage.replace(/^立绘-/, "")]; break;
    case "item": keywords = [task.id, usage.replace(/^物品-/, "")]; break;
    case "background": keywords = [task.id, usage.replace(/^背景-/, "")]; break;
    default: return undefined;
  }
  const kind = task.kind === "figure" ? "character" : task.kind === "item" ? "item" : "background";
  return materials.find((m) => m.kind === kind && nameContains(m.name, keywords));
}
