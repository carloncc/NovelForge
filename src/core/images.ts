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
import { generateImage, ReferenceImageError, VisionApiError, setImageConcurrency, chatCompletion } from "../api/openaiCompatible";
import { resolveImageModelCapabilities } from "../api/providers";
import { verifyImage } from "./selfcheck";
import { describeReferenceImageCached } from "./recognize";
import { tauri } from "../utils/tauri";
import { errMsg } from "../utils/errors";
import { classifyError } from "../utils/errorClassifier";
import { sanitizePrompt, appendSafeStyleSuffix } from "../utils/promptRewriter";
import { cutoutErrorHint } from "../utils/cutoutErrorHint";
import { cacheDirFor, cacheHit } from "./cache";
import { sanitizeId } from "./render";
import { log as logger } from "../utils/logger";
import { updateAssetMap } from "./assetMap";

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
  "lowres, bad anatomy, bad hands, extra fingers, mutated hands, deformed, disfigured, missing fingers, extra digit, watermark, signature, text, logo, jpeg artifacts, blurry, noise, low quality, worst quality, black background, dark background, white background, gray background, plain background, solid color background, gradient background, empty background, scenery, landscape";

// 立绘/物品强制纯色背景：生成纯色底，色度键可稳定抠出透明底（统一使用亮绿色 chroma key green）
// 与视觉圣经绿幕 prompt 保持一致结构：明确"背景区域每个像素都是同一种绿"，并排除黑/白/灰等
// 会被色度键误判的底色（此前多个项目出现 AI 画纯黑底，导致黑色前景被色度键误抠）。
//
// 【发丝/缝隙反阴影加固】AI 对蓬松头发的发丝间隙、衣服褶皱、手指缝隙天然会加"体积阴影/自阴影/环境光遮蔽"
// 让图更立体，但这会导致抠图后这些缝隙残留偏绿暗块。本段前置追加（靠近主提示词，模型权重更高），
// 显式禁止：发丝间/手指间/衣缝间也必须是同一纯绿，禁止任何体积阴影、自阴影、边缘暗化。
const FIGURE_BG_SUFFIX =
  ", solid chroma key green #00FF00 background filling 100% of every exposed area including all gaps between hair strands, between fingers, between clothing folds, and around every body contour edge, the background in these gaps is the EXACT same pure #00FF00 green as the rest of the background, absolutely no volumetric shadow, no self-shadow, no depth darkening, no ambient occlusion, no contact shadow anywhere on the background, the character's silhouette must sit on flat uniform green with no darker green outline ring, on a solid chroma key green background, the background is pure #00FF00 green, completely uniform flat color filling 100% of the background area edge-to-edge, every single pixel of the background area is exactly the same green, absolutely no gradient, no pattern, no texture, no lighting variation, no other colors in the background, no white, no black, no gray, no dark, no light, no scenery, no floor, no objects, no shadow under character, no green elements on the character, character stands centered with green background visible on all four sides, full body visible from head to feet, no legs cut off";
const ITEM_BG_SUFFIX =
  ", object isolated for transparent cutout, on a solid chroma key green background #00FF00 filling 100% of every exposed area including gaps and around the complete object silhouette, the background is exactly uniform pure green with no gradient, pattern, texture, reflection, floor, shadow or text, dark and black parts of the object remain fully opaque with their original colors, no gray transparency on the object, no people, no characters";
/** 三视图绿幕背景后缀：三视图同样强制纯绿幕，与立绘/动作保持一致（作抠图与图生图参考）
 * 【发丝/缝隙反阴影加固】与 FIGURE_BG_SUFFIX 同源：禁止发丝间/手指间/衣缝间体积阴影。 */
const THREEVIEW_GREEN_SUFFIX =
  ", three-view character reference sheet, front view / side view / back view, neutral standing pose, calm expression, full body visible, solid chroma key green #00FF00 background filling 100% of every exposed area including all gaps between hair strands, between fingers, between clothing folds, and around every body contour edge, the background in these gaps is the exact same pure #00FF00 green, absolutely no volumetric shadow, no self-shadow, no depth darkening, no ambient occlusion, no contact shadow on the background, on a solid chroma key green background, the background is pure #00FF00 green, completely uniform flat color filling 100% of the background area, every pixel of the background area is exactly the same green, no gradient, no pattern, no texture, no other colors, no white, no black, no gray, no shadow";

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

/** 背景任务的最终约束：只生成可叠加立绘的环境底图，禁止人物主体污染。 */
const BACKGROUND_EMPTY_SUFFIX =
  ", environment-only background plate for a visual-novel scene, no people, no person, no characters, no human figure, no faces, no portrait, no foreground subject, no humanoid silhouette, no body parts, no statues, no mannequins, no text";

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
    // centered on a light gray background / on a plain background（不带逗号前缀也剥掉，否则与绿幕后缀冲突）
    .replace(/(?:centered|centred|centering|sitting|standing|placed|set)\s+on\s+(?:a\s+)?(?:plain|solid|clean|simple|empty|uniform|colored|white|black|grey|gray|light|dark|deep|vivid|soft|pale|bright|blue|green|red|pink)\s*(?:[\w-]+\s+){0,3}?(?:background|backdrop|wall)\b[^,，;；]*/gi, "")
    .replace(/\bon\s+(?:a\s+)?(?:plain|solid|clean|simple|empty|uniform|colored|white|black|grey|gray|light|dark|deep|vivid|soft|pale|bright|blue|green|red|pink)\s*(?:[\w-]+\s+){0,3}?(?:background|backdrop|wall)\b[^,，;；]*/gi, "")
    .replace(/[,，;；]\s*[^,，;；]*?(纯色背景|纯绿背景|纯白背景|纯灰背景|单一背景|平面背景|干净背景|绿幕背景|白色背景|黑色背景|灰色背景|浅色背景|深色背景|素色背景|纯底色)[^,，;；]*/gi, "")
    .replace(/background\s+with[^,，;；]*/gi, "")
    .replace(/[,，;；]\s*[,，;；]+/g, ",")
    .replace(/[,，;；\s]+$/, "")
    .trim();
}

const SAFE_REWRITE_SYSTEM = `你是 AI 绘图提示词安全改写器。图像模型因提示词疑似涉及裸露/色情/情色/未成年等内容返回审查拒绝。
任务：在保持角色身份、服装款式、姿态、画风、构图完全一致的前提下，把提示词改写成可安全通过审查的版本。
规则：
1. 只输出改写后的提示词正文，不要任何解释。
2. 删除/替换可能触发审查的敏感描述（裸露、紧身暴露、性暗示、未成年、撩拨等），改为保守、健康、全年龄的表述。
3. 保留：发型/瞳色/五官/体型/服装颜色/款式/配饰/姿态/表情/画风关键词/背景约束（含 chroma key green）。
4. 保持英文（若原文是英文则输出英文）。
5. 若提示词已安全无需改动，原样返回。`;

/**
 * 用文本 LLM 把提示词改写成「可安全通过图像审查」的版本（内容审查报错时调用）。
 * 失败返回 null，由调用方兜底（用规则改写或放弃重试）。
 */
async function safeRewritePrompt(cfg: ApiConfig, prompt: string): Promise<string | null> {
  try {
    const r = await chatCompletion(
      cfg,
      [
        { role: "system", content: SAFE_REWRITE_SYSTEM },
        { role: "user", content: `待改写的绘图提示词：\n${prompt}` },
      ],
      { maxTokens: 1500, temperature: 0.2 },
    );
    const rewritten = (r.content || "").trim();
    return rewritten || null;
  } catch {
    return null;
  }
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
  /** 每个角色默认生成的动作数量；0 表示在手动重生成时包含全部动作 */
  maxActionsPerCharacter?: number;
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
  const maxActionsPerCharacter = opts.maxActionsPerCharacter ?? 2;
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
      const actions = maxActionsPerCharacter > 0 ? char.actions.slice(0, maxActionsPerCharacter) : char.actions;
      for (const a of actions) {
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
        prompt: (scene.bgPrompt || `${scene.location} ${scene.atmosphere}, anime background`) + style + (useAnchor ? STYLE_ANCHOR_HINT : "") + BACKGROUND_EMPTY_SUFFIX,
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

/** 生成失败是否可重试（网络/5xx/429/超时/参考图类/服务端临时错误可重试；参数/鉴权/格式类不可重试） */

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
    // 深色背景（黑/墨蓝等）：色度键无法区分黑发/黑衣服/深色物品与深色背景，硬抠会把主体抠成半透明灰。
    // 保留原图（宁可有背景也不伤主体），提示用户可改用 AI 抠图或重新生成绿幕立绘。
    if (res.method === "skip-dark") {
      log({
        step: "图像",
        message: `背景为深色，色度键无法安全抠出主体，已保留原图：${task.usage}（可改用 AI 抠图或重新生成绿幕立绘）`,
        level: "warn",
        at: Date.now(),
      });
      return path;
    }
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
    const msg = errMsg(e);
    const hint = cutoutErrorHint(msg);
    log({
      step: "图像",
      message: `抠图失败，保留原图：${task.usage}（${msg.slice(0, 220)}${hint ? " " + hint : ""}）`,
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
  /** 文本 LLM：内容审查（裸露/色情/未成年等）时用 LLM 把提示词改写成安全版后重试 */
  safeRewriteCfg?: ApiConfig;
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
    let identity: ImageReference | null = null;
    if (generatedPath) {
      try {
        identity = await fileReference(generatedPath, "identity", `Generated identity for ${task.id}`);
      } catch (e) {
        // 参考图文件缺失（上游任务被尺寸校验删除/上轮失败/中断）：不硬失败，降级到圣经图或纯文本生图，
        // 避免一个依赖失败拖垮整批任务（曾出现 20+ 任务连环 REFERENCE_MISSING）。
        logger.warn("images", "生成的参考图缺失，尝试降级", {
          task: task.id,
          refFromTask: task.refFromTask,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (!identity && bibleCharacter) {
      try {
        identity = await fileReference(
          visualBibleArtifactPath(context.outputDir, bibleCharacter.threeViewPath),
          "identity",
          `Approved identity for ${task.characterId}`,
        );
      } catch (e) {
        logger.warn("images", "圣经参考图也缺失，改用纯文本生图", {
          task: task.id,
          characterId: task.characterId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (identity) references.unshift(identity);
    // 无任何可用身份参考图：降级为纯文本生图（角色一致性交给提示词），不再抛 REFERENCE_MISSING
  } else if (characterDerivative && bibleCharacter) {
    try {
      references.unshift(await fileReference(
        visualBibleArtifactPath(context.outputDir, bibleCharacter.threeViewPath),
        "identity",
        `Approved identity for ${task.characterId}`,
      ));
    } catch (e) {
      // 圣经图缺失：降级纯文本生图，不阻断整批
      logger.warn("images", "圣经参考图缺失，该任务降级为纯文本生图", {
        task: task.id,
        characterId: task.characterId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  } else if (task.kind === "threeview" && bibleCharacter && !references.some((reference) => reference.role === "identity")) {
    const storedPath = bibleCharacter.sourceReferencePath ?? bibleCharacter.threeViewPath;
    try {
      references.unshift(await fileReference(
        visualBibleArtifactPath(context.outputDir, storedPath),
        "identity",
        `Character source for ${task.characterId}`,
      ));
    } catch (e) {
      logger.warn("images", "三视图源参考图缺失，该任务降级为纯文本生图", {
        task: task.id,
        characterId: task.characterId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (bible) {
    // 全局风格参考图只用于 BG/CG，不用于角色图（三视图/立绘/动作已有 identity 参考链）。
    // style_reference 参数的"人物特征污染"会导致角色偏离自身描述（如"男身体女头"）。
    const isCharacterImage = task.kind === "threeview" || task.kind === "figure" || task.kind === "action";
    if (!isCharacterImage) {
      try {
        references.push(await fileReference(
          visualBibleArtifactPath(context.outputDir, bible.styleReferencePath),
          "style",
          "Approved global style reference",
          false,
        ));
      } catch (e) {
        // 风格参考图缺失：仅降级为文字风格约束（styleDescription 已合入提示词），不阻断
        logger.warn("images", "全局风格参考图缺失，该任务仅用文字风格约束", {
          task: task.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } else if ((task.kind === "background" || task.kind === "cg") && context.styleAnchorPath) {
    try {
      references.push(await fileReference(context.styleAnchorPath, "style", "Legacy style anchor", false));
    } catch (e) {
      logger.warn("images", "风格锚点图缺失，该任务仅用文字风格约束", {
        task: task.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return references;
}

/** 单个图像任务的已知提示词字符上限：配置里显式设置优先；否则按适配器取常见服务限制。返回 0 = 不主动截断 */
export function imagePromptLimitFor(cfg: ApiConfig): number {
  const n = cfg.extra?.imagePromptCharLimit;
  if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.floor(n);
  if (cfg.adapter === "minimax-image") return 1500;
  return 0;
}

/** 从服务端报错里解析提示词长度上限（如「prompt length must be less than 1500」），解析不到返回 0 */
export function promptLimitFromError(message: string): number {
  const m =
    /prompt length must be less than (\d+)/i.exec(message)
    ?? /提示词.{0,24}(?:超过|不能大于|需小于|必须少于|≤|小于)\s*(\d{3,})/.exec(message);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 200 ? n : 0;
}

/**
 * 把超长绘图提示词压缩到 maxChars 以内：
 * 1. 绿幕/三视图/无人背景等「背景约束后缀」整段优先保留（生成质量依赖，头部给它让预算）；
 * 2. 头部（主体描述）按逗号短语边界截断，去掉中间的风格长句；
 * 3. 极端受限（后缀都放不下）时只保留后缀尾部。
 */
export function fitImagePrompt(prompt: string, maxChars: number): string {
  if (prompt.length <= maxChars) return prompt;
  const constraintIdx = prompt.search(/, solid chroma key green|, on a solid chroma key green|, three-view character reference sheet|, environment-only background plate/i);
  let tail = "";
  let headLimit = maxChars;
  if (constraintIdx >= 0) {
    tail = prompt.slice(constraintIdx);
    headLimit = maxChars - tail.length;
  }
  if (headLimit <= 160) {
    return tail ? tail.slice(-maxChars) : prompt.slice(0, maxChars);
  }
  let head = (constraintIdx >= 0 ? prompt.slice(0, constraintIdx) : prompt).slice(0, headLimit);
  const lastComma = head.lastIndexOf(", ");
  if (lastComma > headLimit * 0.5) head = head.slice(0, lastComma);
  head = head.replace(/[,;，；\s]+$/, "");
  return tail ? `${head}${tail}` : head;
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

  // 视觉圣经三视图复用：角色三视图已在视觉圣经确认过（approved）→ 直接复用其图，不重复生成。
  // 视觉圣经流程已生成并确认 threeview_<id>.png，此处作为最终素材直接引用，避免每轮重生成。
  // 仅「非强制重生成」时复用；force=true（用户主动重生成三视图）时仍走正常生成级联。
  if (task.kind === "threeview" && task.characterId && !opts.force) {
    const approvedBible = opts.visualBible?.status === "approved" ? opts.visualBible : undefined;
    const charBible = approvedBible?.characters?.[task.characterId];
    if (charBible?.threeViewPath && opts.outputDir) {
      const biblePath = `${opts.outputDir.replace(/[\\/]$/, "").replace(/\\/g, "/")}/.novel2vn/visual-bible/${charBible.threeViewPath}`;
      if (await tauri.pathExists(biblePath).catch(() => false)) {
        return biblePath;
      }
    }
  }

  const cached = opts.force ? null : await cacheHit(cacheDir, task.fileName);
  if (cached) {
    // 尺寸校验：缓存图尺寸与要求不一致（如旧竖屏背景）→ 视为缓存失效重新生成
    if (task.width > 0 && task.height > 0) {
      const sizeOk = await tauri.imageSizeMatches(cached, task.width, task.height).catch(() => true);
      if (sizeOk) {
        path = cached;
        source = "缓存";
        logger.debug("images", "图像命中缓存", { id: task.id, fileName: task.fileName });
      } else {
        logger.info("images", "缓存图尺寸与要求不符，重新生成", { id: task.id, fileName: task.fileName, want: `${task.width}x${task.height}` });
        await tauri.removePath(cached).catch(() => {});
        // 删除后继续走下方生成分支（path 仍为 null）
      }
    } else {
      path = cached;
      source = "缓存";
      logger.debug("images", "图像命中缓存", { id: task.id, fileName: task.fileName });
    }
  }
  // 缓存未命中/缓存已作废 → 用户素材或 AI 生成
  if (!path) {
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
      let finalPrompt = task.prompt;
      if (opts.visionCfg?.apiKey && resolvedReferences.length && finalPrompt) {
        const referenceBlocks: string[] = [];
        for (const reference of resolvedReferences) {
          if (!reference.dataB64) continue;
          try {
            let description = await describeReferenceImageCached(opts.visionCfg, reference.dataB64);
            if (description) {
              // 对 style 参考图额外过滤人物相关词，只保留纯风格关键字
              if (reference.role === "style") {
                description = filterStyleOnlyFromDescription(description);
              }
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
            // 视觉描述是可选增强：失败（尤其 429 限流）静默降级为按原提示词生成，
            // 避免每个任务反复刷 warn 且浪费视觉通道配额。
            const status = typeof (e as { status?: number }).status === "number" ? (e as { status?: number }).status : undefined;
            const isRateLimited = status === 429;
            log({
              step: "图像",
              message: isRateLimited
                ? `参考图描述被限流，按原提示词生成：${task.usage}`
                : `参考图描述失败，按原提示词生成：${task.usage}（${errMsg(e).slice(0, 100)}）`,
              level: isRateLimited ? "info" : "warn",
              at: Date.now(),
            });
          }
        }
        if (referenceBlocks.length) {
          // 合并成单一提示词：主体描述在前，参考图描述作为附加约束；避免「风格段 + 主体段」两头式 prompt
          finalPrompt = `${finalPrompt}, ${referenceBlocks.join(", ")}`;
        }
      }
      // 部分图像服务对提示词长度有硬限制（如 MiniMax image-01：prompt ≤1500 字符）。
      // 按已知上限主动压缩（绿幕/背景约束后缀优先保留），避免每个任务先白失败一次。
      const promptLimit = imagePromptLimitFor(cfg);
      if (promptLimit > 0 && finalPrompt.length > promptLimit) {
        logger.info("images", "提示词超长，已按服务端上限压缩", {
          id: task.id,
          from: finalPrompt.length,
          to: promptLimit,
        });
        finalPrompt = fitImagePrompt(finalPrompt, promptLimit);
      }
      // 生成失败自动重试：分类驱动 + 内容审查自动改写提示词 + 递增间隔（1s→10s→20s→…→60s 封顶）
      const retryCount = Math.max(0, opts.retryCount ?? 3) - 1;
      let img: { dataB64: string; mime: string };
      let prompt = finalPrompt;
      // 内容审查改写阶梯：0=原提示词 → 1=规则改写 → 2=LLM 语义改写 → 3=追加全年龄安全后缀
      let moderationStage = 0;
      // 提示词超长压缩：服务端报错携带上限时按上限压缩重试 1 次（覆盖未预设上限的服务）
      let promptFitted = false;
      for (let attempt = 0; ; attempt++) {
        try {
          img = await generateImage(cfg, prompt, {
            references: resolvedReferences,
            size: `${task.width}x${task.height}`,
            seed: task.seed,
            negativePrompt: opts.negativePrompt,
          });
          break;
        } catch (e) {
          const status = typeof (e as { status?: number }).status === "number" ? (e as { status?: number }).status : undefined;
          const rawMessage = e instanceof Error ? e.message : String(e);

          // 提示词超长（如「prompt length must be less than 1500」）：按服务端上限压缩重试 1 次
          const limit = promptLimitFromError(rawMessage);
          if (limit > 0 && !promptFitted) {
            prompt = fitImagePrompt(prompt, limit);
            promptFitted = true;
            log({
              step: "图像",
              message: `提示词超长（服务端上限 ${limit} 字符），已压缩重试：${task.usage}`,
              level: "warn",
              at: Date.now(),
            });
            continue;
          }

          const cls = classifyError(e, status);

          // 内容审查：阶梯式改写提示词重试，最大化过审概率（严格模型连「战斗」「剑」都拒）
          if (cls === "content_moderation" && moderationStage < 3) {
            moderationStage++;
            if (moderationStage === 1) {
              // 第 1 阶：规则改写（快、零成本）；规则没命中时若配了文本 LLM 则顺带完成第 2 阶改写
              const { prompt: safe, replaced } = sanitizePrompt(finalPrompt);
              prompt = safe;
              if (replaced === 0 || safe === finalPrompt) {
                if (opts.safeRewriteCfg?.apiKey) {
                  const llmSafe = await safeRewritePrompt(opts.safeRewriteCfg, finalPrompt);
                  if (llmSafe) {
                    prompt = llmSafe;
                    moderationStage = 2;
                  } else {
                    prompt = appendSafeStyleSuffix(safe);
                  }
                } else {
                  prompt = appendSafeStyleSuffix(safe);
                }
              }
            } else if (moderationStage === 2) {
              // 第 2 阶：LLM 语义改写（对暴力/裸露词更可靠）
              const llmSafe = opts.safeRewriteCfg?.apiKey ? await safeRewritePrompt(opts.safeRewriteCfg, prompt) : null;
              if (llmSafe) {
                prompt = llmSafe;
              } else {
                prompt = appendSafeStyleSuffix(prompt);
                moderationStage = 3;
              }
            } else {
              // 第 3 阶：追加全年龄安全后缀
              prompt = appendSafeStyleSuffix(prompt);
            }
            log({
              step: "图像",
              message: `检测到内容审查，已改写提示词重试（第 ${moderationStage} 阶）：${task.usage}`,
              level: "warn",
              at: Date.now(),
            });
            continue;
          }

          // 内容审查改写全部用尽后仍失败 → 抛出（不再白烧钱）
          if (cls === "content_moderation") {
            log({
              step: "图像",
              message: `生成失败（内容审查，改写后仍失败）：${task.usage}（${errMsg(e).slice(0, 120)}）`,
              level: "error",
              at: Date.now(),
            });
            throw e;
          }
          if (cls === "auth" || cls === "invalid_param" || cls === "aborted") {
            log({
              step: "图像",
              message: `生成失败（${cls}）：${task.usage}（${errMsg(e).slice(0, 120)}）`,
              level: "error",
              at: Date.now(),
            });
            throw e;
          }
          if (attempt >= retryCount) {
            log({
              step: "图像",
              message: `生成失败（已重试耗尽）：${task.usage}（${errMsg(e).slice(0, 120)}）`,
              level: "error",
              at: Date.now(),
            });
            throw e;
          }
          // 网络/限流/未知 → 递增退避重试（首次 1s、二次 10s、之后每次 +10s，封顶 60s）
          const delay = attempt === 0 ? 1000 : Math.min(60_000, attempt * 10_000);
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
  safeRewriteCfg?: ApiConfig,
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

  // 任务 key 覆盖计数：同一 id 多次产出（scene.id 重复等）会互相覆盖 → 记录差异让用户可察觉
  let overwriteCount = 0;
  const record = (task: ImageTask, path: string) => {
    const map =
      task.kind === "background" ? result.bg
      : task.kind === "cg" ? result.cg
      : task.kind === "figure" || task.kind === "threeview" || task.kind === "action" ? result.figure
      : task.kind === "item" ? result.item
      : null;
    if (map && map[task.id] !== undefined && map[task.id] !== path) overwriteCount++;
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

  const write = async (): Promise<void> => {
    await updateAssetMap(projectOutputDir, (assets) => {
      Object.assign(assets.bg, result.bg);
      Object.assign(assets.cg, result.cg);
      Object.assign(assets.figure, result.figure);
      Object.assign(assets.item, result.item);
    });
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
            safeRewriteCfg,
            styleAnchorPath: anchorPath,
            negativePrompt: DEFAULT_NEGATIVE,
          });
          if (p) {
            record(task, p);
            // 先落盘 assets.json 再发进度事件：前端 progress 回调立即读 assets.json 时，
            // 新图映射已写入 → 素材页真正「生成一张显示一个」。
            // （旧顺序先 emitProgress 后 persistIncremental，前端读到旧数据导致中途不刷新）
            await write();
          }
          emitProgress(task);
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
            message: `失败（已跳过，可在「失败项」重试）：${task.usage}（${errMsg(e).slice(0, 100)}）`,
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

  // 任务数 vs 实际产物数差异：scene.id 重复等会导致任务产出互相覆盖（92 个背景任务挤进 6 张），
  // 此处显式告警，避免「生成了但图不够」被静默吞掉。
  const produced = Object.keys(result.bg).length + Object.keys(result.cg).length + Object.keys(result.figure).length + Object.keys(result.item).length;
  const recordableTasks = tasks.filter((t) => t.kind !== "anchor").length;
  const missing = recordableTasks - produced - failed.length;
  if (missing > 0 || overwriteCount > 0) {
    log({
      step: "图像",
      message: `图像阶段完成：任务 ${recordableTasks} 个，产出 ${produced} 张，失败 ${failed.length} 个${missing > 0 ? `，${missing} 个任务产出缺失（多因场景 id 重复互相覆盖）` : ""}${overwriteCount > 0 ? `，${overwriteCount} 个任务 key 被覆盖` : ""}`,
      level: "warn",
      at: Date.now(),
    });
  }
  logger.info("images", "图像素材生成完成", {
    bg: Object.keys(result.bg).length,
    cg: Object.keys(result.cg).length,
    figure: Object.keys(result.figure).length,
    item: Object.keys(result.item).length,
    failed: failed.length,
    overwriteCount,
    recordableTasks,
    produced,
  });

  // 无条件写缓存绑定标记（即使本次有部分任务失败，甚至用户中止）：
  // 成功生成的图已落盘 → 下次 cacheHit 命中；缺失/失败的重新生成（补缺），不会全量重跑。
  // 修复：旧逻辑要求 failed.length===0 且未中止才写，导致任一失败或中止后整批图永远无法缓存复用，
  // 每次重跑项目都全量重新生成（用户报告「中断后必须全部重新生成」）。
  if (approvedBible && cfg) {
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
    await updateAssetMap(outputDir, (assets) => { assets[assetMapKey][assetKey] = newPath; });
    return newPath;
  } catch (e) {
    const msg = errMsg(e);
    const hint = cutoutErrorHint(msg);
    log({ step: "图像", message: `重新抠图失败：${assetKey}（${msg.slice(0, 220)}${hint ? " " + hint : ""}）`, level: "error", at: Date.now() });
    return null;
  }
}
