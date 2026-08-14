import type {
  AssetMap,
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
import { generateImage, ReferenceImageError, VisionApiError, setImageConcurrency } from "../api/openaiCompatible";
import { resolveImageModelCapabilities } from "../api/providers";
import { verifyImage } from "./selfcheck";
import { describeReferenceImage } from "./recognize";
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

// 统一画风：保证同一项目内所有立绘/背景/CG 视觉风格一致（同一个"维度"）
const DEFAULT_STYLE =
  "unified Japanese anime style, cel shading, clean line art, cohesive color palette, high quality illustration, no text, no writing, no signs, no letters";
const STYLE_HINT = "consistent art direction, same visual style, no dimension change";

// 统一负面提示词：避免低质量/畸形/水印等破坏画风与观感的元素
const DEFAULT_NEGATIVE =
  "lowres, bad anatomy, bad hands, extra fingers, mutated hands, deformed, disfigured, missing fingers, extra digit, watermark, signature, text, logo, jpeg artifacts, blurry, noise, low quality, worst quality";

// 立绘/物品强制纯色背景：生成纯色底，色度键可稳定抠出透明底（统一使用亮绿色 chroma key green）
const FIGURE_BG_SUFFIX =
  ", solid chroma key green background (pure #00FF00 green filling the entire background, no gradient, no pattern, no objects, no other people, no text, no shadow, no green elements on the character), full body visible, no legs cut off";
const ITEM_BG_SUFFIX =
  ", solid chroma key green background (pure #00FF00 green filling the entire background, no gradient, no pattern, no reflection, no text, no shadow)";
/** 三视图绿幕背景后缀：三视图同样强制纯绿幕，与立绘/动作保持一致（作抠图与图生图参考） */
const THREEVIEW_GREEN_SUFFIX =
  ", three-view character reference sheet, front view / side view / back view, neutral standing pose, calm expression, full body visible, solid chroma key green background (pure #00FF00 green filling the entire background, no gradient, no pattern, no text, no shadow)";

// 风格锚点：一张纯场景/无人物的画风基准图，后续所有背景/CG 以它做参考图，强制全项目同一画风
const ANCHOR_PROMPT =
  "anime background scenery, a serene countryside valley at golden hour with distant mountains and a small village, soft lighting, cinematic wide shot, no people, no text";

/** 图生图一致性提示：要求与参考图保持同一角色/服装/配色/画风/维度 */
const REF_HINT =
  ", exactly match the reference image: same character, same hair and eye color, same clothing and colors, same art style, same proportions, front-facing full body";

/** 三视图基于角色参考图生成：以参考图为基准，输出正/侧/背三视图设定图（背景由 THREEVIEW_GREEN_SUFFIX 统一附加） */
const THREEVIEW_REF_HINT =
  ", based on the reference image: keep the exact same character (hair, eyes, clothing, colors, proportions, art style), generate a clean three-view character sheet";

/** 背景/CG 风格锚定提示：参考图为画风基准，内容必须全新 */
const STYLE_ANCHOR_HINT =
  ", same exact art style, line rendering, color palette, lighting and texture quality as the reference image, but an entirely different scene with different content";

/** 对 style 参考图的描述做人物特征过滤：保留纯风格要素，去除人物相关词 */
const STYLE_FILTER_WORDS =
  /\b(hair|eyes|eye|face|skin|body|outfit|uniform|dress|skirt|shirt|coat|jacket|shoes|ribbon|bow\s*tie|girl|boy|woman|man|female|male|teen|character|person|people|student|blazer|blouse|stockings|socks)\b/gi;

function filterStyleOnlyFromDescription(description: string): string {
  const filtered = description.replace(STYLE_FILTER_WORDS, "").replace(/\s{2,}/g, " ").trim();
  return filtered || description;
}

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

/** 从立绘 prompt 兜底推导三视图 prompt 主体（不含背景，背景由 THREEVIEW_GREEN_SUFFIX 统一附加） */
function threeViewFallback(imagePrompt: string): string {
  const clean = stripBackground(imagePrompt)
    .replace(/standing pose[^,]*/gi, "")
    .replace(/clean illustration[^,]*/gi, "")
    .replace(/[,，\s]+$/, "");
  return `${clean}, three-view character reference sheet, front view / side view / back view, neutral standing pose, calm expression, full body visible`;
}

/**
 * 剥掉 prompt 里所有"背景/底色"短句，避免 LLM 之前生成的 `plain solid <色> background` /
 * `plain white background` 等与绿幕后缀打架，导致 AI 按旧色画底色。
 * 覆盖中英文常见写法（"plain * background"、"solid * background"、"纯色背景" 等）。
 * 只去掉含 "background" / "底色" / "背景" 的子句，不动人物描述。
 */
export function stripBackground(prompt: string): string {
  if (!prompt) return "";
  return prompt
    .replace(/[,，;；]\s*(?:plain|solid|uniform|clean|simple|empty|white|black|grey|gray|light|dark|deep|pale|bright|vibrant|soft|warm|cool|saturated|muted|pastel|chrome|chroma\s*key|studio|gradient)\s+[^,，;；]*?\b(background|backdrop|wallpaper|scene|setting)\b[^,，;；]*/gi, "")
    .replace(/[,，;；]\s*[^,，;；]*?(plain\s+solid\s+\w+\s+background|plain\s+white\s+background|plain\s+light\s+background|plain\s+dark\s+background|solid\s+color\s+background|solid\s+chroma\s+key\s+green\s+background|clean\s+light\s+gray\s+background|clean\s+white\s+background|empty\s+background|gradient\s+background)[^,，;；]*/gi, "")
    .replace(/[,，;；]\s*(?:white|plain|solid|clean|simple|uniform|light|dark|gray|grey|black|colored|color|transparent)\s*(?:colored\s+)?(?:background|backdrop|wall)\b[^,，;；]*/gi, "")
    .replace(/[,，;；]\s*(?:on|against|in front of)\s+(?:a\s+)?(?:plain|solid|clean|white|black|grey|gray|light|dark)\s*(?:colored\s+)?(?:background|backdrop|wall)\b[^,，;；]*/gi, "")
    .replace(/[,，;；]\s*(?:studio|green|green\s+screen)\s*(?:screen\s*)?(?:background|backdrop)\b[^,，;；]*/gi, "")
    .replace(/[,，;；]\s*[^,，;；]*?(纯色背景|纯绿背景|纯白背景|纯灰背景|单一背景|平面背景|干净背景|绿幕背景|白色背景|黑色背景|灰色背景|浅色背景|深色背景|素色背景|纯底色)[^,，;；]*/gi, "")
    .replace(/background\s+with[^,，;；]*/gi, "")
    .replace(/[,，;；\s]+$/, "")
    .trim();
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
  const cgPerChapter = opts.cgPerChapter ?? 0;
  const maxPerChapter = opts.maxPerChapter ?? 0;
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
          stripBackground(char.threeViewPrompt || threeViewFallback(char.imagePrompt)) +
          style +
          (char.referenceImage ? THREEVIEW_REF_HINT : "") +
          THREEVIEW_GREEN_SUFFIX,
        ...(char.referenceImage ? { references: [inlineIdentityReference(char.referenceImage)] } : {}),
        fileName: `threeview_${sanitizeId(char.id)}.png`,
        width: 1024,
        height: 1024,
        usage: `三视图-${char.name}`,
      });
    }
    // ② 立绘（默认姿态）→ 以三视图为参考图
    // 表情不设上限：优先角色自定义表情集（AI 按剧情提取），缺省用标准 5 表情
    const emotions = useEmotions ? (char.emotions?.length ? char.emotions : FIGURE_EMOTIONS) : ["normal"];
    for (const emo of emotions) {
      const isNormal = emo === "normal";
      tasks.push({
        kind: "figure",
        id: isNormal ? char.id : `${char.id}_${emo}`,
        characterId: char.id,
        emotion: emo,
        prompt: stripBackground(char.imagePrompt) + (EMOTION_PROMPT_SUFFIX[emo] ?? "") + REF_HINT + style + FIGURE_BG_SUFFIX,
        refFromTask: isNormal ? (threeView ? `${char.id}_threeview` : undefined) : char.id,
        fileName: `figure_${sanitizeId(char.id)}_${emo}.png`,
        width: 1024,
        height: 1024,
        usage: `立绘-${char.name}${isNormal ? "" : `（${emo}）`}`,
      });
    }
    // ②b 服装差分立绘（基于三视图图生图；套数按剧情由 AI 决定，不设上限；
    //    每套只生成 normal 姿态作为换装底图，其余表情沿用当前服装）
    if (threeView && Array.isArray(char.costumes)) {
      for (const ct of char.costumes) {
        tasks.push({
          kind: "figure",
          id: `${char.id}_ct_${ct.id}`,
          characterId: char.id,
          emotion: "normal",
          costume: ct.id,
          prompt: stripBackground(ct.prompt) + REF_HINT + style + FIGURE_BG_SUFFIX,
          refFromTask: `${char.id}_threeview`,
          fileName: `figure_${sanitizeId(char.id)}_ct_${sanitizeId(ct.id)}_normal.png`,
          width: 1024,
          height: 1024,
          usage: `立绘-${char.name}-${ct.name}`,
        });
      }
    }
    // ③ 动作立绘（基于三视图图生图；动作数量不限，按角色卡片提取）
    if (threeView && withActions && Array.isArray(char.actions)) {
      for (const a of char.actions) {
        tasks.push({
          kind: "action",
          id: `${char.id}_act_${a.id}`,
          characterId: char.id,
          actionId: a.id,
          prompt: stripBackground(a.prompt) + REF_HINT + style + FIGURE_BG_SUFFIX,
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
      prompt: stripBackground(item.imagePrompt) + style + ITEM_BG_SUFFIX,
      fileName: `item_${sanitizeId(item.id)}.png`,
      width: 1024,
      height: 1024,
      usage: `物品-${item.name}`,
    });
  }

  for (const chapter of chapters) {
    let count = 0;
    for (const scene of chapter.scenes) {
      if (maxPerChapter > 0 && count >= maxPerChapter) break;
      tasks.push({
        kind: "background",
        id: scene.id,
        prompt: (scene.bgPrompt || `${scene.location} ${scene.atmosphere}, anime background, no people`) + style + (useAnchor ? STYLE_ANCHOR_HINT : ""),
        fileName: `bg_${sanitizeId(scene.id)}.png`,
        width: 1536,
        height: 1024,
        usage: `背景-${scene.location}`,
      });
      count++;
    }
    let cgCount = 0;
    for (const scene of chapter.scenes) {
      if (cgPerChapter > 0 && cgCount >= cgPerChapter) break;
      if (scene.cgEvent) {
        tasks.push({
          kind: "cg",
          id: `${chapter.chapter}_${scene.id}`,
          prompt: scene.cgEvent.imagePrompt + style + (useAnchor ? STYLE_ANCHOR_HINT : ""),
          fileName: `cg_${chapter.chapter}_${sanitizeId(scene.id)}.png`,
          width: 1536,
          height: 1024,
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

/** 生成失败是否可重试：网络/5xx/429/超时/参考图类/服务端临时错误可重试；参数/鉴权/格式类不可重试 */
function isRetryableImageError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  const text = message.toLowerCase();
  // 明确不可重试：参数错误/提示词限制/鉴权/资源不存在/格式不支持
  if (/invalid params?|invalid_?request|bad request|400|prompt length|prompt.*(too|must)|does not exist|not found|invalid api key|unauthorized|401|403|permission|not supported|unsupported|not supported|must be|require|missing required|refused by|empty result|结果对象|响应中未找到/.test(text)) {
    return false;
  }
  // 可重试：5xx/429/网络/超时/服务端不可用/参考图类/自检类
  return /5\d\d|429|timeout|timed ?out|network|socket|connect|ec?onn|etimedout|fetch failed|econnrefused|econnreset|broken pipe|server error|unavailable|overloaded|busy|internal|too many|rate limit|reference|retry|temporary/i.test(text);
}

export async function ensureCutout(
  path: string,
  task: ImageTask,
  log: (ev: PipelineEvent) => void,
): Promise<string> {
  // 立绘/动作/物品抠出无背景透明底（优先 AI 抠图，可识别任意背景；失败降级保留原图）。
  // 三视图/背景/CG 不在此处调用（保持自然背景）。
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
  /** 多模态模型：生成前把参考图描述成文字合入提示词，使图生图更严格还原参考图（可选） */
  visionCfg?: ApiConfig;
  /** 风格锚点图路径：背景/CG 以其为参考图统一画风（仅当任务无其它参考图时生效） */
  styleAnchorPath?: string;
  /** 负面提示词（走适配器模板 $negativePrompt，模板未映射则忽略） */
  negativePrompt?: string;
  /** 生成失败重试次数（默认 3 次，含首次；网络/临时错误自动重试） */
  retryCount?: number;
  /** 重试间隔毫秒（默认 3000，每次翻倍） */
  retryDelayMs?: number;
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
    // 全局风格参考图只用于 BG/CG，不用于角色图（三视图/立绘/动作已有 identity 参考链）。
    // style_reference 参数的"人物特征污染"会导致角色偏离自身描述（如"男身体女头"）。
    const isCharacterImage = task.kind === "threeview" || task.kind === "figure" || task.kind === "action";
    if (!isCharacterImage) {
      references.push(await fileReference(
        visualBibleArtifactPath(context.outputDir, bible.styleReferencePath),
        "style",
        "Approved global style reference",
        false,
      ));
    }
  } else if ((task.kind === "background" || task.kind === "cg") && context.styleAnchorPath) {
    references.push(await fileReference(context.styleAnchorPath, "style", "Legacy style anchor", false));
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
    // 尺寸校验：缓存图尺寸与任务要求不一致（如旧竖屏背景）→ 视为缓存失效重新生成
    if (task.width > 0 && task.height > 0) {
      const sizeOk = await tauri.imageSizeMatches(cached, task.width, task.height).catch(() => true);
      if (!sizeOk) {
        logger.info("images", "缓存图尺寸与要求不符，重新生成", { id: task.id, fileName: task.fileName, want: `${task.width}x${task.height}` });
        await tauri.removePath(cached).catch(() => {});
      } else {
        path = cached;
        source = "缓存";
        logger.debug("images", "图像命中缓存", { id: task.id, fileName: task.fileName });
      }
    } else {
      path = cached;
      source = "缓存";
      logger.debug("images", "图像命中缓存", { id: task.id, fileName: task.fileName });
    }
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
      // 参考图增强：有参考图且配置了多模态模型时，先把参考图描述成文字合入提示词。
      // 只提取风格要素（色盘/线条/光影/笔触），不提取人物特征，避免风格参考图污染角色一致性。
      // MiniMax image-01 限制 prompt < 1500 字符；最终截断到安全上限。
      let finalPrompt = task.prompt;
      const MAX_PROMPT_CHARS = 1400;
      if (opts.visionCfg?.apiKey && resolvedReferences.length && finalPrompt) {
        const referenceBlocks: string[] = [];
        for (const reference of resolvedReferences) {
          if (!reference.dataB64) continue;
          const remainingBudget = MAX_PROMPT_CHARS - 300 - referenceBlocks.join(" ").length;
          if (remainingBudget < 100) break;
          try {
            let description = await describeReferenceImage(opts.visionCfg, reference.dataB64);
            if (description) {
              // 对 style 参考图额外过滤人物相关词，只保留纯风格关键字
              if (reference.role === "style") {
                description = filterStyleOnlyFromDescription(description);
              }
              if (description.length > remainingBudget) description = description.slice(0, remainingBudget);
              const roleLabel = reference.role === "style" ? "全局风格参考图" : reference.role === "identity" ? "人物身份参考图" : "参考图";
              referenceBlocks.push(`[${roleLabel}] ${description}`);
              log({
                step: "图像",
                message: `已按参考图描述增强提示词：${task.usage}（${roleLabel}）`,
                level: "info",
                at: Date.now(),
              });
            }
          } catch (e) {
            log({
              step: "图像",
              message: `参考图描述失败，按原提示词生成：${task.usage}（${errMsg(e).slice(0, 100)}）`,
              level: "warn",
              at: Date.now(),
            });
          }
        }
        if (referenceBlocks.length) {
          // 合并成单一提示词：主体描述在前，参考图描述作为附加约束；避免「风格段 + 主体段」两头式 prompt
          finalPrompt = `${finalPrompt}, ${referenceBlocks.join(", ")}`;
        }
      }
      // 兜底截断：所有路径都确保不超过 MiniMax 1500 字符限制
      if (finalPrompt.length > MAX_PROMPT_CHARS) {
        log({ step: "图像", message: `提示词超长（${finalPrompt.length}→${MAX_PROMPT_CHARS}），已截断：${task.usage}`, level: "warn", at: Date.now() });
        finalPrompt = finalPrompt.slice(0, MAX_PROMPT_CHARS);
      }
      // 生成失败自动重试（网络/5xx/超时等临时错误；参数类错误不重试避免浪费）
      const retryCount = Math.max(0, opts.retryCount ?? 3) - 1;
      const baseDelay = opts.retryDelayMs ?? 3000;
      let img: { dataB64: string; mime: string };
      let lastErr: unknown;
      for (let attempt = 0; ; attempt++) {
        try {
          img = await generateImage(cfg, finalPrompt, {
            references: resolvedReferences,
            size: `${task.width}x${task.height}`,
            seed: task.seed,
            negativePrompt: opts.negativePrompt,
          });
          break;
        } catch (e) {
          lastErr = e;
          const retryable = isRetryableImageError(e);
          if (!retryable || attempt >= retryCount) {
            log({
              step: "图像",
              message: `生成失败（${retryable ? "已重试耗尽" : "不可重试"}）：${task.usage}（${errMsg(e).slice(0, 120)}）`,
              level: "error",
              at: Date.now(),
            });
            throw e;
          }
          const isRateLimit = /429|too many|rate limit/i.test(errMsg(e));
          // 429/速率限制退避更长（5s→10s→20s），避免连续打爆 API
          const delay = isRateLimit
            ? 5000 * 2 ** attempt
            : baseDelay * 2 ** attempt;
          log({
            step: "图像",
            message: `生成失败，${delay / 1000}s 后重试（${attempt + 1}/${retryCount}）：${task.usage}（${errMsg(e).slice(0, 100)}）`,
            level: "warn",
            at: Date.now(),
          });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
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
  concurrency = 3,
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
  visionCfg?: ApiConfig,
): Promise<{ images: ImageResultMap; failed: FailedTask[] }> {
  const result: ImageResultMap = { bg: {}, cg: {}, figure: {}, item: {} };
  const failed: FailedTask[] = [];
  // 图片请求限流跟随该 API 自己的并发配置：任务 worker 数与 API 实际并发一致，各 API 互不影响
  if (cfg) setImageConcurrency(cfg, concurrency);
  const approvedBible = visualBible?.status === "approved" ? visualBible : undefined;
  const projectOutputDir = cacheRoot.replace(/[\\/]\.novel2vn[\\/]cache[\\/]?$/, "");
  const tasks = buildImageTasks(chapters, cards, {
    figurePerCharacter: 1,
    cgPerChapter: 0,
    maxPerChapter: 0,
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

  // 每生成一张立即增量写入 assets.json：即使中途失败/中止，已生成的图也已落盘，
  // 下次只需重跑缺失项，不必整体重新生成。
  let assetsPersistInFlight: Promise<void> | null = null;
  const persistIncremental = (): void => {
    const write = async (): Promise<void> => {
      const assetsFile = `${projectOutputDir}/.novel2vn/assets.json`;
      let existing: AssetMap | null = null;
      try {
        const { text } = await tauri.readTextFile(assetsFile);
        existing = JSON.parse(text) as AssetMap;
      } catch {
        existing = null;
      }
      const next: AssetMap = {
        bg: { ...(existing?.bg ?? {}), ...result.bg },
        cg: { ...(existing?.cg ?? {}), ...result.cg },
        figure: { ...(existing?.figure ?? {}), ...result.figure },
        item: { ...(existing?.item ?? {}), ...result.item },
        vocal: existing?.vocal ?? {},
      };
      try {
        await tauri.writeTextFile(assetsFile, JSON.stringify(next, null, 2));
      } catch {
        /* 增量落盘失败不阻断生成 */
      }
    };
    if (assetsPersistInFlight) {
      assetsPersistInFlight = assetsPersistInFlight.then(write, write);
    } else {
      assetsPersistInFlight = write().finally(() => {
        assetsPersistInFlight = null;
      });
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
            visionCfg,
            styleAnchorPath: anchorPath,
            negativePrompt: DEFAULT_NEGATIVE,
          });
          emitProgress(task);
          if (p) {
            record(task, p);
            persistIncremental();
          }
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

/** 对单张素材重新抠图：读取图片 → 抠出透明底 → 更新 assets.json 映射。
 * 用于素材页「抠图」按钮，出问题时单独重抠而无需重新生成整张图。
 * 返回抠图后的新文件路径；若已透明/无需抠图则返回原路径。
 * 注意：背景/CG 属于场景图，不抠图（仅立绘/物品可抠透明底）。
 */
export async function reCutoutAsset(
  outputDir: string,
  assetMapKey: "figure" | "item",
  assetKey: string,
  filePath: string,
  log: (ev: PipelineEvent) => void,
): Promise<string | null> {
  const metaDir = `${outputDir}/.novel2vn`;
  const task: ImageTask = {
    kind: assetMapKey === "item" ? "item" : "figure",
    id: assetKey,
    fileName: filePath.split(/[\\/]/).pop() || "asset.png",
    prompt: "",
    width: 0,
    height: 0,
  };
  try {
    const newPath = await ensureCutout(filePath, task, log);
    // 更新 assets.json 中该 key 的映射
    const assetsFile = `${metaDir}/assets.json`;
    let map: AssetMap = { bg: {}, cg: {}, figure: {}, item: {}, vocal: {} };
    try {
      const { text } = await tauri.readTextFile(assetsFile);
      map = JSON.parse(text) as AssetMap;
    } catch {
      /* 无旧映射 */
    }
    map[assetMapKey][assetKey] = newPath;
    try {
      await tauri.writeTextFile(assetsFile, JSON.stringify(map, null, 2));
    } catch {
      /* 忽略 */
    }
    return newPath;
  } catch (e) {
    log({ step: "图像", message: `重新抠图失败：${assetKey}（${errMsg(e).slice(0, 120)}）`, level: "error", at: Date.now() });
    return null;
  }
}
