import type {
  ChapterScript,
  CharacterCard,
  ExtractionResult,
  FailedTask,
  FigureDetail,
  ImageReference,
  ImageTask,
  ItemCard,
  MaterialAsset,
  PipelineEvent,
  ProjectVisualBible,
  VisualBibleCacheBinding,
} from "./types";
import type { ApiConfig } from "./types";
import { generateImage, ReferenceImageError, VisionApiError, setImageConcurrency, chatCompletion } from "../api/openaiCompatible";
import { referenceRouteRejection, resolveImageModelCapabilities } from "../api/providers";
import { verifyImage } from "./selfcheck";
import { describeReferenceImageCached } from "./recognize";
import { tauri } from "../utils/tauri";
import { errMsg } from "../utils/errors";
import { classifyError } from "../utils/errorClassifier";
import { sanitizePrompt, appendSafeStyleSuffix } from "../utils/promptRewriter";
import { cutoutErrorHint } from "../utils/cutoutErrorHint";
import { imageMimeForPath } from "../utils/mime";
import { configState } from "../stores/config";
import { cacheDirFor, cacheHit } from "./cache";
import { sanitizeId } from "./render";
import { log as logger } from "../utils/logger";
import { readAssetMap, updateAssetMap } from "./assetMap";

export interface ImageResultMap {
  bg: Record<string, string>;
  cg: Record<string, string>;
  figure: Record<string, string>;
  item: Record<string, string>;
}

/** B77：figure 映射被 threeview/figure/action 三类任务共用键空间，同键任务互相覆盖且只事后告警。
 *  构建期显式抛错并带上冲突键与来源，便于定位是角色 id / 表情 id / 动作 id 的哪组撞了。 */
export class ImageTaskKeyConflictError extends Error {
  readonly code = "IMAGE_TASK_KEY_CONFLICT" as const;
  readonly key: string;
  readonly sources: string[];

  constructor(key: string, sources: string[]) {
    super(`IMAGE_TASK_KEY_CONFLICT: 图像任务键 "${key}" 被多个来源共用（${sources.join(" 与 ")}），后生成的图会覆盖先生成的`);
    this.name = "ImageTaskKeyConflictError";
    this.key = key;
    this.sources = sources;
  }
}

function nameContains(name: string, keywords: string[]): boolean {
  return keywords.some((k) => k && name.includes(k));
}

const FIGURE_EMOTIONS = ["normal", "happy", "sad", "angry", "surprised"];

/**
 * 本章出现的角色 id：台词说话人（含分支选项）＋场景出场表；旁白不算。
 * 单章模式的图像任务裁剪与章节灯（chapterAssets）共用同一口径，两边一致才能收敛。
 */
export function chapterCharacterIds(chapter: ChapterScript): Set<string> {
  const out = new Set<string>();
  const add = (id?: string): void => {
    if (!id || id === "narrator") return;
    out.add(id);
  };
  for (const scene of chapter.scenes) {
    for (const id of scene.figures ?? []) add(id);
    for (const line of scene.lines ?? []) {
      if (line.type === "dialogue") add(line.characterId);
    }
    for (const choice of scene.choices ?? []) {
      for (const line of choice.lines ?? []) {
        if (line.type === "dialogue") add(line.characterId);
      }
    }
  }
  return out;
}

/** 本章 itemEvents 引用到的物品 id。 */
export function chapterItemIds(chapter: ChapterScript): Set<string> {
  const out = new Set<string>();
  for (const scene of chapter.scenes) {
    for (const ev of scene.itemEvents ?? []) {
      if (ev.itemId) out.add(ev.itemId);
    }
  }
  return out;
}

// 情绪提示词：必须足够明确（五官/眉/嘴），否则模型会把不同情绪画成雷同的笑脸；
// 所有情绪统一约束自然站姿+手臂下垂，避免模型给表情加戏配怪手势。
const NATURAL_POSE_GUARD = ", arms relaxed at sides, natural relaxed standing pose, no hand gestures";
const EMOTION_PROMPT_SUFFIX: Record<string, string> = {
  normal: ", calm neutral expression, mouth closed, looking straight ahead, standing upright straight, symmetric front-facing pose, feet planted on the ground, arms relaxed at sides",
  happy: ", joyful bright smile with teeth showing, eyes slightly squinted with happiness, genuinely cheerful laughing expression, radiant happy face" + NATURAL_POSE_GUARD,
  sad: ", clearly sad crying expression, eyebrows tilted up, mouth frowning downward, watery teary eyes, absolutely no smile, sorrowful distressed face" + NATURAL_POSE_GUARD,
  angry: ", clearly angry irritated expression, furrowed sharp angry eyebrows, glaring narrowed eyes, tight frowning mouth, absolutely no smile, fierce annoyed face" + NATURAL_POSE_GUARD,
  surprised: ", shocked surprised expression, eyes wide open, mouth open in surprise, raised eyebrows, absolutely no smile" + NATURAL_POSE_GUARD,
};

// 非 happy 情绪时，把基础提示里的"笑"类正面表情词清掉，避免模型仍按基础画笑脸
const SMILE_FACE_WORDS = /\b(smiling|smile|grinning|grin|chuckle|laughing|laugh|cheerful|joyful|cheery|gleeful|radiant|merry|happy)\b/gi;
// 立绘人像只换表情不换姿势：所有情绪都清掉基础提示里的手势/动态姿势词，只保留自然站姿。
// 此前只在 normal 时清理，happy 等情绪会把基础里的挥手/指物/比耶等手势带进来，配上表情就成了怪动作。
const FIGURE_GESTURE_WORDS = /\b(one hand raised|hand raised in a \w+ wave|waving|waves|waved|waving one hand|pointing|thumbs up|peace sign|hand on hip|hands on hips|winking|giving a wave)\b/gi;

function emotionPrompt(base: string, emo: string, label?: string): string {
  let p = stripBackground(base);
  if (emo !== "happy") {
    p = p.replace(SMILE_FACE_WORDS, " ");
  }
  p = p.replace(FIGURE_GESTURE_WORDS, " ");
  // 自定义表情（表外键）：旧实现后缀为空，生成的图彼此都与 normal 雷同；这里补显式表情约束
  const specific = EMOTION_PROMPT_SUFFIX[emo]
    ?? `, clearly showing the "${label || emo}" facial expression, expressive face with matching eyes, eyebrows and mouth` + NATURAL_POSE_GUARD;
  return p.replace(/\s{2,}/g, " ").trim() + specific;
}

// 动作立绘：只做 prompt 里明确写出的姿态要素，其余一律保持自然放松站姿。
// 严禁模型自行脑补手势——此前的 "clearly performing the described hand gesture"
// 会逼模型给纯表情动作（如撒娇鼓脸）凭空配一个举手，出来全是怪动作。
const ACTION_CLARITY_HINT = ", perform only the pose elements explicitly described above, everything else in a natural relaxed standing pose with arms resting naturally at sides, do not invent any hand gestures, no raised hands, no waving, no pointing, no peace sign, no thumbs up, no hands on hips unless explicitly described, full body visible";

// 统一画风：保证同一项目内所有立绘/背景/CG 视觉风格一致（同一个"维度"）
const DEFAULT_STYLE =
  "unified Japanese anime style, cel shading, clean line art, cohesive color palette, high quality illustration, no text, no writing, no signs, no letters";
const STYLE_HINT = "consistent art direction, same visual style, no dimension change";

// 统一负面提示词：避免低质量/畸形/水印等破坏画风与观感的元素
const DEFAULT_NEGATIVE =
  "lowres, bad anatomy, bad hands, extra fingers, mutated hands, deformed, disfigured, missing fingers, extra digit, watermark, signature, text, logo, jpeg artifacts, blurry, noise, low quality, worst quality, black background, dark background, white background, gray background, plain background, solid color background, gradient background, empty background, scenery, landscape";

// 立绘/物品强制纯色背景：生成纯色底，色度键可稳定抠出透明底（统一使用亮绿色 chroma key green）
// 与视觉守门绿幕 prompt 保持一致结构：明确"背景区域每个像素都是同一种绿"，并排除黑/白/灰等
// 会被色度键误判的底色（此前多个项目出现 AI 画纯黑底，导致黑色前景被色度键误抠）。
//
// 【发丝/缝隙反阴影加固】AI 对蓬松头发的发丝间隙、衣服褶皱、手指缝隙天然会加"体积阴影/自阴影/环境光遮蔽"
// 让图更立体，但这会导致抠图后这些缝隙残留偏绿暗块。本段前置追加（靠近主提示词，模型权重更高），
// 显式禁止：发丝间/手指间/衣缝间也必须是同一纯绿，禁止任何体积阴影、自阴影、边缘暗化。
const FIGURE_BG_SUFFIX =
  ", solid chroma key green #00FF00 background filling 100% of every exposed area including all gaps between hair strands, between fingers, between clothing folds, and around every body contour edge, the background in these gaps is the EXACT same pure #00FF00 green as the rest of the background, absolutely no volumetric shadow, no self-shadow, no depth darkening, no ambient occlusion, no contact shadow anywhere on the background, the character's silhouette must sit on flat uniform green with no darker green outline ring, on a solid chroma key green background, the background is pure #00FF00 green, completely uniform flat color filling 100% of the background area edge-to-edge, every single pixel of the background area is exactly the same green, absolutely no gradient, no pattern, no texture, no lighting variation, no other colors in the background, no white, no black, no gray, no dark, no light, no scenery, no floor, no objects, no shadow under character, no green elements on the character, character stands centered with green background visible on all four sides, full body visible from head to feet including shoes, the whole figure fits inside the frame with the complete head and both feet clearly visible, nothing cropped, no half-body framing, no close-up, no waist-up composition";
const ITEM_BG_SUFFIX =
  ", object isolated for transparent cutout, on a solid chroma key green background #00FF00 filling 100% of every exposed area including gaps and around the complete object silhouette, the background is exactly uniform pure green with no gradient, pattern, texture, reflection, floor, shadow or text, dark and black parts of the object remain fully opaque with their original colors, no gray transparency on the object, no people, no characters";

/** 人物类任务的构图负面词：明确排除半身/裁切/特写，保证立绘全身（三视图同） */
const FIGURE_NEGATIVE =
  "half body, half-body, portrait crop, bust shot, waist-up composition, close-up, cropped head, cropped legs, cropped feet, out of frame, zoomed-in framing";
const FIGURE_KINDS = new Set<ImageTask["kind"]>(["figure", "action", "threeview"]);

/** 本次任务的有效负面词 = 全局负面词 +（人物类任务）构图负面词 */
function effectiveNegative(task: ImageTask, negativePrompt: string | undefined): string | undefined {
  const parts = [negativePrompt?.trim(), FIGURE_KINDS.has(task.kind) ? FIGURE_NEGATIVE : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

/** 三视图绿幕背景后缀：三视图同样强制纯绿幕，与立绘/动作保持一致（作抠图与图生图参考）
 * 【发丝/缝隙反阴影加固】与 FIGURE_BG_SUFFIX 同源：禁止发丝间/手指间/衣缝间体积阴影。 */
const THREEVIEW_GREEN_SUFFIX =
  ", three-view character reference sheet, front view / side view / back view, neutral standing pose, calm expression, full body visible, solid chroma key green #00FF00 background filling 100% of every exposed area including all gaps between hair strands, between fingers, between clothing folds, and around every body contour edge, the background in these gaps is the exact same pure #00FF00 green, absolutely no volumetric shadow, no self-shadow, no depth darkening, no ambient occlusion, no contact shadow on the background, on a solid chroma key green background, the background is pure #00FF00 green, completely uniform flat color filling 100% of the background area, every pixel of the background area is exactly the same green, no gradient, no pattern, no texture, no other colors, no white, no black, no gray, no shadow";

// 风格锚点：一张纯场景/无人物的画风基准图，后续所有背景/CG 以它做参考图，强制全项目同一画风
const ANCHOR_PROMPT =
  "anime background scenery, a serene countryside valley at golden hour with distant mountains and a small village, soft lighting, cinematic wide shot, no people, no text";

/** 图生图一致性提示：要求与参考图保持同一角色/服装/配色/画风/维度，且全身构图 */
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
  cgPerChapter?: number;
  maxPerChapter?: number;
  figureEmotions?: boolean;
  /** 人物图详细度：core=标准5表情＋无服装差分（省图）；full=AI全量表情＋服装＋动作（默认） */
  detail?: FigureDetail;
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
  /**
   * 章节过滤：只为这些章节（ChapterScript.chapter，0-based 连续编号）构建背景/CG 任务。
   * 锚点/三视图/立绘/动作/物品是全项目级任务，不受影响（命中缓存直接复用，且情绪/动作 passes 需要立绘引用）。
   */
  chapterIndexes?: Set<number>;
  /**
   * 视觉模式（#806/#809）：sprite=立绘版（默认）；imageOnly=图片小说——
   * 只产出「角色三视图（identity 参考）＋ 每场景分镜（kind:"shot"）＋（可选）物品图」，
   * 不产出立绘/表情/动作/服装差分，也不做抠图（透明需求由渲染侧规避）。
   */
  mode?: "sprite" | "imageOnly";
  /** 图片小说：每场景分镜张数上限（0=不限；提示词侧已按用户旋钮约束，这里兜底裁剪并告警） */
  shotsPerScene?: number;
  /** 图片小说：每章分镜总量上限（0=不限；超出按顺序裁剪并告警，不允许静默丢弃） */
  shotsPerChapter?: number;
  /** 图片小说：全局分镜总量/预算上限（0=不限；到达上限停止派发新任务，已生成产物保留） */
  shotsTotal?: number;
  /** 图片小说：是否生成物品图（默认 false，与 #814 的「图片必须含角色」口径一致） */
  includeItems?: boolean;
}

export function buildImageTasks(
  chapters: ChapterScript[],
  cards: ExtractionResult,
  opts: BuildImageTaskOptions = {},
): ImageTask[] {
  const tasks: ImageTask[] = [];
  const cgPerChapter = opts.cgPerChapter ?? 0;
  const maxPerChapter = opts.maxPerChapter ?? 0;
  const useEmotions = opts.figureEmotions !== false;
  const detail = opts.detail ?? "full";
  const threeView = opts.threeView !== false;
  const withActions = opts.actions !== false;
  const maxActionsPerCharacter = opts.maxActionsPerCharacter ?? 2;
  const baseStyle = styleSuffix(opts.style);
  const style = opts.feedback ? `${baseStyle}, ${opts.feedback.trim().replace(/[。.]$/, "")}` : baseStyle;
  // 绿幕类提示词专用风格：人物/三视图/动作/服装/物品一律纯绿幕，风格文本里若带背景词
  // （风格综合/用户手写都可能带，如 "soft gradient background"）会与绿幕后缀冲突，先剥掉；
  // 背景/CG/锚点继续用完整风格（那里的背景描述是合法的）。
  const figureStyle = stripBackground(style);
  const useAnchor = opts.styleAnchor !== false;
  const imageOnly = opts.mode === "imageOnly";
  const shotsPerScene = opts.shotsPerScene ?? 0;
  const shotsPerChapter = opts.shotsPerChapter ?? 0;
  const shotsTotal = opts.shotsTotal ?? 0;
  let shotTotalCount = 0;
  let shotTotalReached = false;

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
          figureStyle +
          (char.referenceImage ? THREEVIEW_REF_HINT : "") +
          THREEVIEW_GREEN_SUFFIX,
        ...(char.referenceImage ? { references: [inlineIdentityReference(char.referenceImage)] } : {}),
        fileName: `threeview_${sanitizeId(char.id)}.png`,
        width: 1024,
        height: 1024,
        usage: `三视图-${char.name}`,
      });
    }
    // ② 立绘/表情/动作/服装差分：图片小说模式一律不产出（#809：无立绘、无人物演出 UI）
    if (!imageOnly) {
      // ② 立绘（默认姿态）→ 以三视图为参考图
      // core 档：只用标准 5 表情（忽略 AI 自定义大表情集，省图）；
      // full 档：优先角色自定义表情集（AI 按剧情提取），缺省用标准 5 表情
      const baseEmotions = !useEmotions ? ["normal"] : detail === "core" ? FIGURE_EMOTIONS : (char.emotions?.length ? char.emotions : FIGURE_EMOTIONS);
      // 强制包含 normal 并去重/消毒：表情集缺 normal 会导致默认立绘整张缺失、所有差分 refFromTask 断链；
      // 自定义表情名含中文/符号时旧实现直接拼文件名（可能路径穿越/覆盖），按动作同一口径 sanitize（原值保留给提示词）
      const emoList: { raw: string; id: string }[] = [];
      const seenEmo = new Set<string>();
      for (const raw of ["normal", ...baseEmotions]) {
        const id = sanitizeId(String(raw)) || "normal";
        if (seenEmo.has(id)) continue;
        seenEmo.add(id);
        emoList.push({ raw: String(raw), id });
      }
      for (const { raw: emoRaw, id: emoId } of emoList) {
        const isNormal = emoId === "normal";
        tasks.push({
          kind: "figure",
          id: isNormal ? char.id : `${char.id}_${emoId}`,
          characterId: char.id,
          emotion: emoId,
          prompt: emotionPrompt(char.imagePrompt, emoId, emoRaw) + REF_HINT + figureStyle + FIGURE_BG_SUFFIX,
          refFromTask: isNormal ? (threeView ? `${char.id}_threeview` : undefined) : char.id,
          fileName: `figure_${sanitizeId(char.id)}_${emoId}.png`,
          width: 1024,
          height: 1024,
          usage: `立绘-${char.name}${isNormal ? "" : `（${emoRaw}）`}`,
        });
      }
      // ②b 服装差分立绘（基于三视图图生图；full 档才生成，core 档跳过以省图；
      //    每套只生成 normal 姿态作为换装底图，其余表情沿用当前服装）
      if (threeView && detail !== "core" && Array.isArray(char.costumes)) {
        for (const ct of char.costumes) {
          tasks.push({
            kind: "figure",
            id: `${char.id}_ct_${ct.id}`,
            characterId: char.id,
            emotion: "normal",
            costume: ct.id,
            prompt: stripBackground(ct.prompt) + REF_HINT + figureStyle + FIGURE_BG_SUFFIX,
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
            prompt: stripBackground(a.prompt) + ACTION_CLARITY_HINT + REF_HINT + figureStyle + FIGURE_BG_SUFFIX,
            refFromTask: `${char.id}_threeview`,
            fileName: `figure_${sanitizeId(char.id)}_act_${sanitizeId(a.id)}.png`,
            width: 1024,
            height: 1024,
            usage: `动作-${char.name}-${a.name}`,
          });
        }
      }
    }
  }

  if (!imageOnly || opts.includeItems) {
    for (const item of cards.items) {
      tasks.push({
        kind: "item",
        id: item.id,
        prompt: stripBackground(item.imagePrompt) + figureStyle + ITEM_BG_SUFFIX,
        fileName: `item_${sanitizeId(item.id)}.png`,
        width: 1024,
        height: 1024,
        usage: `物品-${item.name}`,
    });
  }
  }

  for (const chapter of chapters) {
    // 图片小说（#809）：只构建分镜任务（kind:"shot"）——画面由 shot 承担，
    // 不产出背景/CG 任务；无 shot 的场景在渲染侧保留上一张图（不会出现黑屏）。
    if (imageOnly) {
      if (opts.chapterIndexes && !opts.chapterIndexes.has(chapter.chapter)) continue;
      let chapterShotCount = 0;
      for (const scene of chapter.scenes) {
        const shots = shotsPerScene > 0 ? (scene.shots ?? []).slice(0, shotsPerScene) : (scene.shots ?? []);
        for (let si = 0; si < shots.length; si++) {
          if (shotsPerChapter > 0 && chapterShotCount >= shotsPerChapter) {
            logger.warn("images", `第 ${chapter.chapter + 1} 章分镜超过每章上限 ${shotsPerChapter}，已裁剪多余分镜（可提高上限后重跑）`, { chapter: chapter.chapter });
            break;
          }
          if (shotsTotal > 0 && shotTotalCount >= shotsTotal) {
            if (!shotTotalReached) {
              shotTotalReached = true;
              logger.warn("images", `分镜总量已达上限 ${shotsTotal}，停止派发新分镜（已完成产物保留；提高上限后可续跑）`, { shotsTotal });
            }
            break;
          }
          const shot = shots[si];
          const identity = (shot.characters ?? []).find((id) => cards.characters.some((c) => c.id === id));
          tasks.push({
            kind: "shot",
            id: shot.id,
            chapter: chapter.chapter,
            sceneId: scene.id,
            shotIndex: si,
            ...(identity ? { characterId: identity, refFromTask: `${identity}_threeview` } : {}),
            prompt: shot.prompt + style,
            fileName: `shot_ch${chapter.chapter + 1}_${sanitizeId(scene.id)}_${si + 1}.png`,
            width: 1536,
            height: 1024,
            usage: `分镜-${scene.location}${shot.note ? `-${shot.note}` : ""}`,
          });
          chapterShotCount++;
          shotTotalCount++;
        }
        if (shotsTotal > 0 && shotTotalCount >= shotsTotal) break;
      }
      continue;
    }
    // 单章节模式：只构建选中章节的背景/CG 任务，其余章节复用已有映射
    if (opts.chapterIndexes && !opts.chapterIndexes.has(chapter.chapter)) continue;
    let count = 0;
    for (const scene of chapter.scenes) {
      if (maxPerChapter > 0 && count >= maxPerChapter) break;
      tasks.push({
        kind: "background",
        id: scene.id,
        chapter: chapter.chapter,
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
        // CG 键只用 scene.id（scene.id 已跨章唯一化）：旧键 cg_<章节号>_<scene> 导致
        // 光章节重编号就全作废、全重生成；旧版文件/映射由 repairImageAssets 与分区兜底迁移。
        tasks.push({
          kind: "cg",
          id: scene.id,
          chapter: chapter.chapter,
          prompt: scene.cgEvent.imagePrompt + style + (useAnchor ? STYLE_ANCHOR_HINT : ""),
          fileName: `cg_${sanitizeId(scene.id)}.png`,
          width: 1536,
          height: 1024,
          usage: `CG-${scene.cgEvent.title}`,
        });
        cgCount++;
      }
    }
  }

  // B77：figure 键唯一性断言。threeview/figure/action 都会写 result.figure，同 id 会互相覆盖——
  // 例如角色 "alice_threeview" 的立绘 id 与角色 "alice" 的三视图 id 相同，实际只留下一张图。
  // 这里在构建期显式失败（含冲突键与来源），由既有调用方失败隔离处理，不再等覆盖后才告警。
  const figureKeySources = new Map<string, string>();
  for (const t of tasks) {
    if (t.kind !== "figure" && t.kind !== "threeview" && t.kind !== "action") continue;
    const source = `${t.kind}:${t.id}（${t.usage ?? t.fileName}）`;
    const existing = figureKeySources.get(t.id);
    if (existing && existing !== source) throw new ImageTaskKeyConflictError(t.id, [existing, source]);
    figureKeySources.set(t.id, source);
  }

  // 确定性种子：按任务 id 哈希派生（baseSeed + fnv1a(id)），与任务顺序无关——
  // 增删角色/章节不再导致后续所有任务种子漂移，旧实现 baseSeed+i 顺序分配一动全变。
  // 同 id 出现多次（如裸调 buildImageTasks 未做跨章去重时）按出现次序加盐，保证同输入下唯一且稳定；
  // 管线内已做 dedupeSceneIdsAcrossChapters，实跑中 id 唯一、不触发加盐分支。
  if (opts.baseSeed !== undefined) {
    const seen = new Map<string, number>();
    for (const t of tasks) {
      const key = `${t.kind}:${t.id}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      // 种子输入含 kind：background:s1 与 cg:s1 同 scene.id 不能同种子
      t.seed = taskSeedForId(opts.baseSeed, n > 1 ? `${key}#${n}` : key);
    }
  }

  return tasks;
}

/** 任务 id 稳定种子：FNV-1a 哈希后叠加基数，钳制到 31bit 正整数（各图片 API 通用范围） */
export function taskSeedForId(baseSeed: number, taskId: string): number {
  let h = 2166136261;
  for (const ch of taskId) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return (Math.floor(baseSeed) + (h >>> 0)) % 2147483647;
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
  // 立绘/动作/物品抠出无背景透明底（优先 AI 抠图，可识别任意背景；失败降级色度键/保留原图）。
  // 三视图/背景/CG 不在此处调用（保持自然背景）。
  try {
    const mode = configState.cutout?.mode ?? "ai";
    // 抠图方式=关闭：直接保留原图（日志明确标注，方便确认当前生效方式）
    if (mode === "off") {
      log({ step: "图像", message: `无背景立绘（未抠图，开关已关闭）：${task.usage}`, level: "info", at: Date.now() });
      return path;
    }
    const b64 = await tauri.readFileBase64(path);
    if (await tauri.hasTransparency(b64)) return path;
    // 抠图方式=色度键：跳过 AI 模型直走色度键；=AI 优先：先试 AI，失败降级色度键
    const aiResult = mode === "ai" ? await tryAiCutout(b64, task, log) : null;
    if (aiResult) {
      // B71：抠图结果按字节签名落 `.png`（GIF 等未识别时保持原扩展名）
      const pngPath = withDetectedExt(path, aiResult);
      await tauri.writeFileBase64(pngPath, aiResult);
      if (pngPath !== path) {
        await tauri.removePath(path).catch(() => {});
      }
      log({ step: "图像", message: `无背景立绘（AI 抠图）：${task.usage}`, level: "info", at: Date.now() });
      return pngPath;
    }
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
    // 过激保护（Rust/Web 均可能返回）：透明占比过高说明主体被误抠，保留原图而不是把残缺图当「已抠图」写盘
    if (res.method === "skip-overcut") {
      log({
        step: "图像",
        message: `色度键抠图疑似过激（主体可能被误删），已保留原图：${task.usage}（可改用 AI 抠图或重新生成绿幕立绘）`,
        level: "warn",
        at: Date.now(),
      });
      return path;
    }
    const out = res.dataB64;
    // B71：色度键结果按字节签名落 `.png`（GIF 等未识别时保持原扩展名）
    const pngPath = withDetectedExt(path, out);
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

/** AI 抠图（可选模型，手动下载）：未启用/模型未安装/推理失败均返回 null，由调用方降级。 */
let aiCutoutHintLogged = false;

async function tryAiCutout(
  b64: string,
  task: ImageTask,
  log: (ev: PipelineEvent) => void,
): Promise<string | null> {
  const settings = configState.cutout;
  if (settings?.mode !== "ai") return null;
  const { findCutoutModel, cutoutModelStatus, aiCutoutImage, cutoutModelExpectedPath } = await import("./cutout");
  const model = findCutoutModel(settings.modelId);
  let status: { installed: boolean };
  try {
    status = await cutoutModelStatus(model);
  } catch {
    return null;
  }
  if (!status.installed) {
    // 只提示一次，避免批量生成时刷屏；带上期望位置，目录对不上时一眼可见
    if (!aiCutoutHintLogged) {
      aiCutoutHintLogged = true;
      const expected = await cutoutModelExpectedPath(model).catch(() => model.filename);
      log({
        step: "图像",
        message: `AI 抠图模型「${model.label}」（${model.sizeMB} MB）未安装（期望位置：${expected}），已用色度键抠图：${task.usage}（可到「API 配置」页下载模型）`,
        level: "info",
        at: Date.now(),
      });
    }
    return null;
  }
  try {
    const result = await aiCutoutImage(b64, model.id, { despill: true });
    return result.dataB64;
  } catch (error) {
    const raw = errMsg(error);
    // dev 下 onnxruntime 胶水模块走 /onnx 中间件：报错里带这些关键字基本就是 dev 没重启
    const devHint = /onnx|ort-wasm|\.jsep|should not be imported from source code/i.test(raw)
      ? "（疑似 dev 服务器未重启：请 Ctrl+C 后重新启动再试）"
      : "";
    log({
      step: "图像",
      message: `AI 抠图失败（模型「${model.label}」）：${raw.slice(0, 300)}${devHint}，降级色度键：${task.usage}`,
      level: "warn",
      at: Date.now(),
    });
    return null;
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
  /**
   * 协作式中止检查（与 generateImages 同口径）：返回 true 时不再发起任何新的付费请求
   * （参考图描述 / 图像生成 / 提示词改写 / 退避重试 / 自检）。已在途的请求无法撤回，
   * 其结果是已付费产物，仍会保留落盘。缺省（undefined）表示不中止。
   */
  isAborted?: () => boolean;
}

export interface ImageReferenceResolutionContext {
  outputDir: string;
  visualBible?: ProjectVisualBible;
  figureBase?: Record<string, string>;
  styleAnchorPath?: string;
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

function visualBibleArtifactCachePath(outputDir: string, storedPath: string): string {
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
        // 参考图文件缺失（上游任务被尺寸校验删除/上轮失败/中断）：不硬失败，降级到视觉守门图或纯文本生图，
        // 避免一个依赖失败拖垮整批任务（曾出现 20+ 任务连环 REFERENCE_MISSING）。
        logger.warn("images", "生成的参考图缺失，尝试降级", {
          task: task.id,
          refFromTask: task.refFromTask,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (!identity && bibleCharacter) {
      // 换装任务优先引用该服装的独立三视图锚点（保证换装后身份/服装一致）；
      // B72：锚点文件读取失败（被删/损坏）时回退默认装三视图再试，而不是直接让任务失败。
      const costumeSheet = task.costume ? bibleCharacter.costumeSheets?.[task.costume] : undefined;
      const candidates: { path: string; label: string }[] = [];
      if (costumeSheet?.threeViewPath) candidates.push({ path: costumeSheet.threeViewPath, label: `costume ${task.costume}` });
      candidates.push({ path: bibleCharacter.threeViewPath, label: "default three-view" });
      for (const candidate of candidates) {
        try {
          identity = await fileReference(
            visualBibleArtifactCachePath(context.outputDir, candidate.path),
            "identity",
            `Approved identity for ${task.characterId} (${candidate.label})`,
          );
          break;
        } catch (e) {
          logger.warn("images", "视觉守门参考图缺失", {
            task: task.id,
            characterId: task.characterId,
            fallback: candidate.label,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
    if (identity) references.unshift(identity);
    // 身份参考缺失必须显式失败（进入「失败项」可逐条重试/补图），不再静默降级为纯文本生图：
    // 旧实现静默降级会让角色形象与已批准三视图漂移，违背 README「参考文件缺失会明确报错」承诺
    if (!identity) {
      throw new ReferenceImageError(
        `Identity reference missing for task ${task.id} (refFromTask=${task.refFromTask})`,
        "REFERENCE_MISSING",
      );
    }
  } else if (characterDerivative && bibleCharacter) {
    try {
      references.unshift(await fileReference(
        visualBibleArtifactCachePath(context.outputDir, bibleCharacter.threeViewPath),
        "identity",
        `Approved identity for ${task.characterId}`,
      ));
    } catch (e) {
      // 视觉守门图缺失：显式失败而不是静默纯文生图（保持角色一致性承诺）
      logger.warn("images", "视觉守门参考图缺失，任务失败等待补图", {
        task: task.id,
        characterId: task.characterId,
        error: e instanceof Error ? e.message : String(e),
      });
      throw new ReferenceImageError(
        `Approved identity missing for task ${task.id} (character=${task.characterId})`,
        "REFERENCE_MISSING",
      );
    }
  } else if (task.kind === "threeview" && bibleCharacter && !references.some((reference) => reference.role === "identity")) {
    const storedPath = bibleCharacter.sourceReferencePath ?? bibleCharacter.threeViewPath;
    try {
      references.unshift(await fileReference(
        visualBibleArtifactCachePath(context.outputDir, storedPath),
        "identity",
        `Character source for ${task.characterId}`,
      ));
    } catch (e) {
      logger.warn("images", "三视图源参考图缺失，任务失败等待补图", {
        task: task.id,
        characterId: task.characterId,
        error: e instanceof Error ? e.message : String(e),
      });
      throw new ReferenceImageError(
        `Three-view source reference missing for task ${task.id} (character=${task.characterId})`,
        "REFERENCE_MISSING",
      );
    }
  }

  if (bible) {
    // 全局风格参考图只用于 BG/CG，不用于角色图（三视图/立绘/动作已有 identity 参考链）。
    // style_reference 参数的"人物特征污染"会导致角色偏离自身描述（如"男身体女头"）。
    const isCharacterImage = task.kind === "threeview" || task.kind === "figure" || task.kind === "action";
    if (!isCharacterImage) {
      try {
        references.push(await fileReference(
          visualBibleArtifactCachePath(context.outputDir, bible.styleReferencePath),
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

/* ---------- B69：图像缓存旁路参数元数据 ----------
 * 缓存 key 只有文件名，模型/种子/负面词/尺寸变化后旧图会被误命中（改了模型仍复用旧画风）。
 * 生成时把本次参数摘要写入 `<图>.meta.json`，命中时比对；旧缓存无 meta 视为命中（兼容存量）。 */

interface ImageArtifactMeta {
  v: 1;
  adapter: string | null;
  model: string | null;
  seed: number | null;
  negativePrompt: string | null;
  width: number;
  height: number;
}

/** 本次任务对应的生成参数摘要（不写入 prompt：调用方可能只改反馈词，内容复用由调用方决定） */
function imageMetaForTask(task: ImageTask, cfg: ApiConfig | undefined, negativePrompt: string | undefined): ImageArtifactMeta {
  return {
    v: 1,
    adapter: cfg?.adapter ?? null,
    model: cfg?.model ?? null,
    seed: typeof task.seed === "number" ? task.seed : null,
    negativePrompt: negativePrompt?.trim() ? negativePrompt : null,
    width: task.width,
    height: task.height,
  };
}

function imageMetaMatches(meta: ImageArtifactMeta, expected: ImageArtifactMeta): boolean {
  return meta.v === expected.v
    && meta.adapter === expected.adapter
    && meta.model === expected.model
    && meta.seed === expected.seed
    // 期望值没有负面词（如背景/CG，且用户未配置）时不比较，避免单素材重生成后的旧缓存被误判参数不符而重复付费；
    // 期望值有负面词时必须一致：人物任务现在带「防半身/裁切」构图负面词，旧的无负面词记录必须视为未命中重画。
    && (expected.negativePrompt === null || meta.negativePrompt === expected.negativePrompt)
    && meta.width === expected.width
    && meta.height === expected.height;
}

/** 命中校验：无 meta（旧缓存）视为命中以兼容存量；meta 参数不一致 → 缓存作废重生成。 */
async function cachedImageMetaMatches(path: string, expected: ImageArtifactMeta): Promise<boolean> {
  try {
    const { text } = await tauri.readTextFile(`${path}.meta.json`);
    const meta = JSON.parse(text) as Partial<ImageArtifactMeta>;
    if (meta?.v !== 1) return true;
    return imageMetaMatches(meta as ImageArtifactMeta, expected);
  } catch {
    return true;
  }
}

async function writeImageArtifactMeta(path: string, meta: ImageArtifactMeta): Promise<void> {
  try {
    await tauri.writeTextFile(`${path}.meta.json`, JSON.stringify(meta));
  } catch (e) {
    // 旁路元数据写失败不影响出图：下次命中按旧缓存处理，仅记录
    logger.warn("images", "缓存参数旁路元数据写入失败（下次命中按旧缓存处理）", { path, error: errMsg(e) });
  }
}

/* ---------- B71：按真实字节签名修正扩展名 ----------
 * API 可能按内容而非请求 mime 返回 JPEG/WebP，旧实现固定按 mime 写 `.png`，
 * 落盘扩展名与内容不一致（`.png` 装 JPEG），WebView/游戏引擎按扩展名解码会失败。 */

/** 按 base64 字节魔数识别真实图片格式（PNG/JPEG/WebP/GIF）；识别不出返回 null。 */
export function detectedImageExtension(dataB64: string): string | null {
  try {
    const head = dataB64.replace(/\s+/g, "").slice(0, 32);
    const bytes = typeof Buffer !== "undefined"
      ? new Uint8Array(Buffer.from(head, "base64"))
      : Uint8Array.from(atob(head), (c) => c.charCodeAt(0));
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
    return null;
  } catch {
    return null;
  }
}

/** 用真实字节签名改写文件扩展名；未知签名保持原扩展名（保底不破坏现有命名）。 */
export function withDetectedExt(path: string, dataB64: string): string {
  const ext = detectedImageExtension(dataB64);
  if (!ext) return path;
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  return dot > slash ? `${path.slice(0, dot)}.${ext}` : `${path}.${ext}`;
}

/** 执行单个图像任务（管线批处理与单素材重生成共用） */
export async function runImageTask(
  cfg: ApiConfig | undefined,
  task: ImageTask,
  cacheRoot: string,
  log: (ev: PipelineEvent) => void,
  opts: ImageRunOptions = {},
): Promise<string | null> {
  /** 协作式中止：已中止则整任务直接跳过（管线会统一给出中止说明，这里不重复刷日志） */
  const aborted = (): boolean => opts.isAborted?.() === true;
  if (aborted()) return null;
  const cacheDir = cacheDirFor(cacheRoot, "images");
  await tauri.mkdirAll(cacheDir);
  let path: string | null = null;
  let source = "";
  let resolvedReferences: ImageReference[] = [];
  let materialReference: ImageReference | undefined;

  // 视觉守门三视图复用：角色三视图已在视觉守门确认过（approved）→ 直接复用其图，不重复生成。
  // 视觉守门流程已生成并确认 threeview_<id>.png，此处作为最终素材直接引用，避免每轮重生成。
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
    // B69：旁路参数校验（模型/种子/负面词/尺寸）。无 cfg 时无法重新生成，跳过校验保持旧行为。
    const metaOk = !cfg || await cachedImageMetaMatches(cached, imageMetaForTask(task, cfg, effectiveNegative(task, opts.negativePrompt)));
    if (!metaOk) {
      logger.info("images", "缓存图生成参数（模型/种子/负面词/尺寸）与当前任务不一致，重新生成", {
        id: task.id,
        fileName: task.fileName,
      });
    } else if (task.width > 0 && task.height > 0) {
      // 尺寸校验：缓存图尺寸与要求不一致（如旧竖屏背景）→ 视为缓存失效重新生成
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
    // 已中止：连素材拷贝与「生成中」日志都不再发起
    if (aborted()) return null;
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
        // B71：素材真实字节可能是 JPEG/WebP，落盘后按魔数改名为正确扩展名，避免 `.png` 装 JPEG。
        const copiedPath = `${cacheDir}/${task.fileName}`;
        await copyMaterial(mat, copiedPath);
        let finalPath = copiedPath;
        try {
          finalPath = withDetectedExt(copiedPath, await tauri.readFileBase64(copiedPath));
          if (finalPath !== copiedPath) {
            await tauri.copyFile(copiedPath, finalPath);
            await tauri.removePath(copiedPath).catch(() => {});
          }
        } catch {
          /* 读取失败保底用原路径（内容仍可用） */
        }
        path = finalPath;
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
          // 已中止：不再调用视觉模型描述参考图（每个参考图一次付费调用）
          if (aborted()) return null;
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
        // 已中止：不再发起新的付费生成请求（本书最主要的花钱点）
        if (aborted()) return null;
        try {
          img = await generateImage(cfg, prompt, {
            references: resolvedReferences,
            size: `${task.width}x${task.height}`,
            seed: task.seed,
            negativePrompt: effectiveNegative(task, opts.negativePrompt),
          });
          break;
        } catch (e) {
          // 已中止：不再做提示词改写/退避重试等任何后续（每次都是新的付费调用）
          if (aborted()) return null;
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

          // 线路不接受带参考图的请求：重试/改写都不会成功，静默丢参考图又会破坏角色一致性
          // → 直接失败并给出可执行的修复提示（重新探测该线路的图像能力 / 换线路）。
          if (e instanceof ReferenceImageError && e.code === "REFERENCE_UNSUPPORTED" && resolvedReferences.length > 0) {
            log({
              step: "图像",
              message: `生成失败（当前线路不接受参考图）：${task.usage}。${referenceRouteRejection(rawMessage) ?? errMsg(e)}`,
              level: "error",
              at: Date.now(),
            });
            throw e;
          }

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
          // 退避期间分段检查中止，避免最长 60s 的无效等待
          const resumeAt = Date.now() + delay;
          while (!aborted() && Date.now() < resumeAt) {
            await new Promise((r) => setTimeout(r, Math.min(250, resumeAt - Date.now())));
          }
          if (aborted()) return null;
        }
      }
      // B71：优先按真实字节签名落扩展名（API 常忽略请求 mime 返回 jpeg/webp）；识别不出再按响应 mime 兜底
      const detected = detectedImageExtension(img.dataB64);
      const file = detected
        ? withDetectedExt(task.fileName, img.dataB64)
        : task.fileName.replace(/\.png$/, `.${img.mime.includes("jpeg") ? "jpg" : "png"}`);
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
  if (path && opts.verifyCfg && source === "AI 生成" && !aborted()) {
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
    // B69：AI 生成结果写入旁路参数元数据（供下次命中校验）；用户素材拷贝不写，按旧缓存兼容处理。
    if (source.startsWith("AI 生成") && cfg) {
      await writeImageArtifactMeta(path, imageMetaForTask(task, cfg, effectiveNegative(task, opts.negativePrompt)));
    }
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
  cgPerChapter = 0,
  maxPerChapter = 0,
  chapterScope?: Set<number>,
  figureDetail: FigureDetail = "full",
  /** 单章强制：这些章节（与 chapterScope 同口径的章节编号）的背景/CG 跳过缓存直接重画（人物/物品不受影响） */
  chapterForce: Set<number> = new Set(),
): Promise<{ images: ImageResultMap; failed: FailedTask[]; generated: number }> {
  const result: ImageResultMap = { bg: {}, cg: {}, figure: {}, item: {} };
  const failed: FailedTask[] = [];
  /** 实际走 API 生成并产出的任务数（缓存命中、跳过、中断、用户素材本地拷贝不计） */
  let generatedCount = 0;
  /** 命中用户素材的待执行任务：走本地拷贝、免费，完成后不计入 generatedCount */
  const materialFree = new Set<ImageTask>();
  // 图片请求限流跟随该 API 自己的并发配置：任务 worker 数与 API 实际并发一致，各 API 互不影响
  if (cfg) setImageConcurrency(cfg, concurrency);
  const approvedBible = visualBible?.status === "approved" ? visualBible : undefined;
  const projectOutputDir = cacheRoot.replace(/[\\/]\.novel2vn[\\/]cache[\\/]?$/, "");
  const imageCacheDir = cacheDirFor(cacheRoot, "images");
  const visualBibleCacheMarker = `${imageCacheDir}/.visual-bible-fingerprint`;
  const approvedCacheBinding = approvedBible ? cacheBindingForBible(approvedBible) : undefined;
  const storedCacheBinding = approvedBible
    ? await readCacheBinding(visualBibleCacheMarker, approvedBible, approvedCacheBinding!)
    : undefined;
  const globalCacheCurrent = !approvedBible
    || storedCacheBinding?.globalFingerprint === approvedCacheBinding?.globalFingerprint;

  /** 视觉守门已批准的三视图成品路径（文件存在才算）。B78：守门复用不写 images 缓存目录，
   *  裁剪/预分区只查缓存会永远认为缺三视图 → 单章反复建任务、进度与计费计数虚增。 */
  const approvedThreeViewArtifact = async (characterId: string): Promise<string | null> => {
    if (!approvedBible) return null;
    const stored = approvedBible.characters?.[characterId]?.threeViewPath;
    if (!stored) return null;
    const artifactPath = visualBibleArtifactCachePath(projectOutputDir, stored);
    return (await tauri.pathExists(artifactPath).catch(() => false)) ? artifactPath : null;
  };

  // 单章模式精简人物/物品构建：已有三视图/物品图成品、且视觉守门修订未变的角色/物品，
  // 根本不建任务（而非建完再跳过）——400+ 任务的 stat 开销与"顺手生成计费"一并消除。
  // 新角色（无三视图）、新物品、视觉守门修订、force/意见、全量模式不受影响。
  let taskCards = cards;
  // 单章/多选模式：人物图与物品图先收窄到本次范围章节真正用到的角色/物品。
  // 章节灯（chapterScopeImageTasks）按同一口径计数，两边一致才不会出现
  // 「灯显示差图、单章却永远补不上」。
  if (chapterScope) {
    const scopedChapters = chapters.filter((c) => chapterScope.has(c.chapter));
    if (scopedChapters.length) {
      const usedChars = new Set<string>();
      const usedItems = new Set<string>();
      for (const scoped of scopedChapters) {
        for (const id of chapterCharacterIds(scoped)) usedChars.add(id);
        for (const id of chapterItemIds(scoped)) usedItems.add(id);
      }
      const charactersInScope = taskCards.characters.filter((c) => usedChars.has(c.id));
      const itemsInScope = taskCards.items.filter((it) => usedItems.has(it.id));
      if (charactersInScope.length < taskCards.characters.length || itemsInScope.length < taskCards.items.length) {
        const beforeChars = taskCards.characters.length;
        const beforeItems = taskCards.items.length;
        taskCards = { ...taskCards, characters: charactersInScope, items: itemsInScope };
        log({
          step: "图像",
          message: `单章模式：人物/物品图按本次章节的出场范围收窄（角色 ${beforeChars}→${charactersInScope.length}、物品 ${beforeItems}→${itemsInScope.length}）；未出场角色的图画到对应章节时再生成`,
          level: "info",
          at: Date.now(),
        });
      }
    }
  }
  if (chapterScope && !force && !feedback && globalCacheCurrent) {
    /** 该角色在完整档下应有的全部差分/服装/动作文件名（与 buildImageTasks 命名逐字一致）。 */
    const derivativeFileNames = (c: CharacterCard): string[] => {
      const names: string[] = [];
      const emoList = !figureEmotions
        ? ["normal"]
        : figureDetail === "core"
          ? FIGURE_EMOTIONS
          : (c.emotions?.length ? c.emotions : FIGURE_EMOTIONS);
      for (const emo of emoList) names.push(`figure_${sanitizeId(c.id)}_${emo}.png`);
      if (threeView && figureDetail !== "core") {
        for (const ct of c.costumes ?? []) names.push(`figure_${sanitizeId(c.id)}_ct_${sanitizeId(ct.id)}_normal.png`);
      }
      if (threeView && withActions) {
        for (const a of c.actions ?? []) names.push(`figure_${sanitizeId(c.id)}_act_${sanitizeId(a.id)}.png`);
      }
      return names;
    };
    const keepChars: CharacterCard[] = [];
    let skippedChars = 0;
    // B69：裁剪判定同时校验旁路参数 meta——模型/种子/负面词变化后旧缓存不算「已有成品」，
    // 否则单章模式会因"文件在"直接跳过构建，参数不匹配的旧图永远不重生成。
    const expectedCharacterMetas = (c: CharacterCard): Map<string, ImageArtifactMeta> => {
      const metas = new Map<string, ImageArtifactMeta>();
      if (!cfg) return metas;
      try {
        const built = buildImageTasks([], { title: "", characters: [c], scenes: [], items: [] }, {
          figureEmotions,
          detail: figureDetail,
          threeView,
          actions: withActions,
          baseSeed,
          styleAnchor: approvedBible ? false : styleAnchor,
        });
        for (const t of built) if (t.fileName) metas.set(t.fileName, imageMetaForTask(t, cfg, effectiveNegative(t, DEFAULT_NEGATIVE)));
      } catch {
        /* 单角色任务构建失败时退回旧行为（无 meta 视为命中），主流程构建会再抛 */
      }
      return metas;
    };
    for (const c of taskCards.characters) {
      const revised = !!approvedCacheBinding
        && storedCacheBinding?.characterRevisions[c.id] !== approvedCacheBinding.characterRevisions[c.id];
      let hasThree: string | null = null;
      try {
        hasThree = await cacheHit(imageCacheDir, `threeview_${sanitizeId(c.id)}.png`);
      } catch {
        hasThree = null;
      }
      // B78：缓存目录没有时再看视觉守门三视图（获批三视图的复用产物）
      if (!hasThree) hasThree = await approvedThreeViewArtifact(c.id);
      if (!hasThree || revised) {
        keepChars.push(c);
        continue;
      }
      // 只有三视图还不够：开启表情差分 / 切到完整档 / 新增服装动作后，
      // 缺的差分若因为"三视图存在"被一起裁掉，单章和队列都永远补不上。
      const expectedMetas = expectedCharacterMetas(c);
      let complete = true;
      for (const name of derivativeFileNames(c)) {
        const hit = await cacheHit(imageCacheDir, name).catch(() => null);
        const expected = expectedMetas.get(name);
        if (!hit || (expected && !(await cachedImageMetaMatches(hit, expected)))) {
          complete = false;
          break;
        }
      }
      if (complete) skippedChars++;
      else keepChars.push(c);
    }
    const keepItems: ItemCard[] = [];
    let skippedItems = 0;
    for (const it of taskCards.items) {
      let hasItem: string | null = null;
      try {
        hasItem = await cacheHit(imageCacheDir, `item_${sanitizeId(it.id)}.png`);
      } catch {
        hasItem = null;
      }
      const itemTask = cfg
        ? buildImageTasks([], { title: "", characters: [], scenes: [], items: [it] }, { styleAnchor: false })[0]
        : undefined;
        const expectedMeta = itemTask?.fileName ? imageMetaForTask(itemTask, cfg, effectiveNegative(itemTask, DEFAULT_NEGATIVE)) : null;
      if (!hasItem || (expectedMeta && !(await cachedImageMetaMatches(hasItem, expectedMeta)))) keepItems.push(it);
      else skippedItems++;
    }
    if (skippedChars > 0 || skippedItems > 0) {
      taskCards = { ...taskCards, characters: keepChars, items: keepItems };
      log({
        step: "图像",
        message: `单章模式：${skippedChars} 个角色（三视图与全部差分/服装/动作均已有成品）、${skippedItems} 个物品图已有成品，本次不构建任务（未重生成、0 计费）`,
        level: "info",
        at: Date.now(),
      });
    }
  }

  const tasks = buildImageTasks(chapters, taskCards, {
    cgPerChapter,
    maxPerChapter,
    figureEmotions,
    detail: figureDetail,
    style: approvedBible?.styleDescription ?? style,
    feedback,
    threeView,
    actions: withActions,
    baseSeed,
    styleAnchor: approvedBible ? false : styleAnchor,
    chapterIndexes: chapterScope,
  });

  await tauri.mkdirAll(cacheDirFor(cacheRoot, "images"));
  const imageForceFor = (task: ImageTask): boolean => {
    if (force || !globalCacheCurrent) return true;
    // 单章强制：只重画点名章节的背景/CG（人物/物品是项目级的，不动）
    if (chapterForce.size > 0 && (task.kind === "background" || task.kind === "cg")
      && task.chapter !== undefined && chapterForce.has(task.chapter)) return true;
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

  // 实时进度与分 pass 定义见下方静默预分区之后（进度只统计实际执行的任务）

  // 任务 key 覆盖计数：同一 id 多次产出（scene.id 重复等）会互相覆盖 → 记录差异让用户可察觉
  let overwriteCount = 0;
  // B68：assets.json 落盘改为内存缓冲 + 节流合并写。
  // 旧实现每张图成功都调用 updateAssetMap（全量读 + 全量写），400 张图 = 400 次递增全量重写（O(n²)）。
  // 现在：每 12 张或 2s（先到者）合并写一次，函数结束前强制 flush；失败只告警不阻断出图。
  // 取舍：单张完成瞬间前端读到的 assets.json 可能滞后到上一批（最迟约 2s）；前端生成期本就有
  // 2s 轮询 assets.json（stores/generate.ts startAssetLiveRefresh），素材页以轮询为准不会漏图。
  const ASSET_FLUSH_MAX_PENDING = 12;
  const ASSET_FLUSH_INTERVAL_MS = 2000;
  let assetsPending = 0;
  let assetFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let assetFlushChain: Promise<void> = Promise.resolve();
  let assetFlushWarned = false;
  const flushAssetsNow = (): Promise<void> => {
    if (assetsPending === 0) return assetFlushChain;
    assetsPending = 0;
    if (assetFlushTimer !== null) {
      clearTimeout(assetFlushTimer);
      assetFlushTimer = null;
    }
    const merge = updateAssetMap(projectOutputDir, (assets) => {
      Object.assign(assets.bg, result.bg);
      Object.assign(assets.cg, result.cg);
      Object.assign(assets.figure, result.figure);
      Object.assign(assets.item, result.item);
    }).catch((e) => {
      // 写失败不能阻断整批生成：文件已落盘，结束后会再 flush 一次；仅首次告警避免刷屏
      if (!assetFlushWarned) {
        assetFlushWarned = true;
        logger.warn("images", "assets.json 增量写入失败（素材页可能滞后，流程结束时会再写一次）", { error: errMsg(e) });
      }
    });
    assetFlushChain = assetFlushChain.then(() => merge, () => merge);
    return assetFlushChain;
  };
  const scheduleAssetFlush = (): void => {
    if (assetsPending >= ASSET_FLUSH_MAX_PENDING) {
      void flushAssetsNow();
      return;
    }
    if (assetFlushTimer !== null) return;
    assetFlushTimer = setTimeout(() => {
      assetFlushTimer = null;
      void flushAssetsNow();
    }, ASSET_FLUSH_INTERVAL_MS);
  };

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
    if (map) {
      assetsPending++;
      scheduleAssetFlush();
    }
  };

  // 静默预分区：纯文件缓存命中的任务直接记入结果，不走执行/进度/写盘链路。
  // 解决"点一次图像重生成，全书 N 张图挨个走一遍进度"——命中只是本地文件存在性＋尺寸检查＋meta 参数校验，
  // 不产生 API 调用。force/用户素材/尺寸或参数不符等情况仍进 pending，由 runImageTask 原逻辑处理。
  // （imageCacheDir 见函数开头，单章精简已复用）
  const pending: ImageTask[] = [];
  let cacheReused = 0;
  for (const task of tasks) {
    if (imageForceFor(task)) {
      pending.push(task);
      continue;
    }
    // B78：视觉守门已批准三视图的复用（runImageTask 直接引用守门产物、不写 images 缓存）直接记入结果，
    // 不进 pending → 不发进度、不计 generatedCount，修复三视图"假生成"导致的计数虚增。
    const bibleThreeView = task.kind === "threeview" && task.characterId
      ? await approvedThreeViewArtifact(task.characterId)
      : null;
    if (bibleThreeView) {
      record(task, bibleThreeView);
      cacheReused++;
      continue;
    }
    let hit: string | null = null;
    try {
      const c = await cacheHit(imageCacheDir, task.fileName);
      // B69：旁路参数 meta 不一致的旧缓存视为未命中（重生成）；无 meta 的存量缓存仍命中。
      const metaOk = !!c && (!cfg || await cachedImageMetaMatches(c, imageMetaForTask(task, cfg, effectiveNegative(task, DEFAULT_NEGATIVE))));
      if (c && metaOk) {
        if (task.width > 0 && task.height > 0) {
          hit = (await tauri.imageSizeMatches(c, task.width, task.height).catch(() => true)) ? c : null;
        } else {
          hit = c;
        }
      }
    } catch {
      hit = null;
    }
    if (hit) {
      record(task, hit);
      cacheReused++;
    } else {
      // 用户素材本地拷贝免费：与 runImageTask 同判定（item＋已批准视觉守门＋有 API 时作参考图仍计费，其余拷贝免费）
      const billableRef = !!cfg && task.kind === "item" && !!approvedBible;
      if (!billableRef && findMaterial(materials, task)) materialFree.add(task);
      pending.push(task);
    }
  }

  // 旧版 CG 文件迁移（一次性）：旧命名 cg_<章节号>_<scene>.png → 新命名 cg_<scene>.png。
  // scene.id 跨章唯一，可直接改名复用，避免改键后旧 CG 全被误判缺失而重生成。
  if (pending.some((t) => t.kind === "cg")) {
    try {
      const entries = await tauri.listDir(imageCacheDir);
      const legacy = entries.filter((e) => !e.isDir && /^cg_\d+_.+\.(png|jpg|jpeg|webp)$/i.test(e.name));
      if (legacy.length) {
        const pendingCg = new Map(pending.filter((t) => t.kind === "cg").map((t) => [t.fileName.replace(/\.(png|jpg|jpeg|webp)$/i, ""), t]));
        for (const e of legacy) {
          const base = e.name.replace(/\.(png|jpg|jpeg|webp)$/i, "");
          const scenePart = base.replace(/^cg_\d+_/, "cg_");
          const task = pendingCg.get(scenePart);
          if (task) {
            const target = `${imageCacheDir}/${task.fileName}`;
            try {
              await tauri.copyFile(e.path, target);
              record(task, target);
              cacheReused++;
              pending.splice(pending.indexOf(task), 1);
              log({ step: "图像", message: `旧版 CG 已迁移复用（免重生成）：${task.usage}`, level: "info", at: Date.now() });
            } catch {
              /* 迁移失败则正常生成 */
            }
          }
        }
      }
    } catch {
      /* 目录不存在等，忽略 */
    }
  }

  // 实时进度：total 只统计实际执行的任务（每个恰好发一次进度）；纯缓存命中不发进度事件、不写盘、不刷素材页
  const total = pending.length;
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

  // 五阶段执行（链式图生图保证形象/画风一致），仅对未命中任务：
  // 风格锚点 → 三视图 → 默认立绘+背景/CG/物品（背景/CG 以锚点为参考）→ 表情差分（以默认立绘为参考）→ 动作（以三视图为参考）
  const leadingPass = pending.filter((t) => t.kind === "threeview");
  // 默认立绘的 emotion 为 "normal"，必须归入首轮，否则表情差分没有参考图（曾导致角色形象漂移）
  const firstPass = pending.filter(
    (t) => (t.kind === "figure" && (!t.emotion || t.emotion === "normal")) || t.kind === "background" || t.kind === "cg" || t.kind === "item",
  );
  const emotionPass = pending.filter((t) => t.kind === "figure" && t.emotion && t.emotion !== "normal");
  const actionPass = pending.filter((t) => t.kind === "action");

  if (pending.length === 0) {
    const figureTotal = tasks.filter((t) => t.kind === "figure" || t.kind === "threeview" || t.kind === "action").length;
    log({
      step: "图像",
      message: `图像阶段完成：${cacheReused} 项全部命中缓存，无需生成（0 计费${figureTotal > 0 ? `；人物基础图 ${figureTotal} 张全部复用，未重生成` : ""}）`,
      level: "success",
      at: Date.now(),
    });
  } else if (cacheReused > 0) {
    const parts: string[] = [];
    const nBg = pending.filter((t) => t.kind === "background").length;
    const nCg = pending.filter((t) => t.kind === "cg").length;
    const nFig = pending.filter((t) => t.kind === "figure" || t.kind === "threeview" || t.kind === "action").length;
    const nItem = pending.filter((t) => t.kind === "item").length;
    const nAnchor = pending.filter((t) => t.kind === "anchor").length;
    if (nBg) parts.push(`背景 ${nBg}`);
    if (nCg) parts.push(`CG ${nCg}`);
    if (nFig) parts.push(`人物图 ${nFig}`);
    if (nItem) parts.push(`物品图 ${nItem}`);
    if (nAnchor) parts.push(`风格锚点 ${nAnchor}`);
    log({
      step: "图像",
      message: `缓存复用 ${cacheReused} 项${nFig === 0 ? "（人物基础图全部复用，未重生成）" : ""}，实际生成 ${pending.length} 项（${parts.join("、")}）…`,
      level: "info",
      at: Date.now(),
    });
  }

  /** B74：视觉通道级致命错误（配置错误/模型不支持看图/响应非法）。
   *  此类错误对每个任务都会重复发生，继续执行只会持续付费；记录为共享状态后，
   *  所有 worker 在循环入口/下一轮停止派发（已在途的请求无法取消，允许跑完），
   *  函数末尾仍向调用方抛出，保持原错误契约。 */
  let fatalError: VisionApiError | null = null;

  const runPass = async (pass: ImageTask[], anchorPath?: string) => {
    let idx = 0;
    const worker = async () => {
      while (idx < pass.length) {
        if (fatalError || isAborted?.()) return;
        const task = pass[idx++];
        try {
          const p = await runImageTask(cfg, task, cacheRoot, log, {
            materials,
            force: imageForceFor(task),
            isAborted,
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
            if (!materialFree.has(task)) generatedCount++;
            // B68：只登记缓冲并按节流合并落盘（每 12 张 / 2s），不再逐张全量重写 assets.json；
            // 前端素材页由 2s 轮询 assets.json 兜底刷新，逐步接近旧「先落盘再发进度」的可见性。
          } else if (isAborted?.()) {
            // 已中止且本任务未产出：不计进度、不上屏（避免停止后进度条继续涨）
            return;
          }
          emitProgress(task);
        } catch (e) {
          if (e instanceof VisionApiError) {
            // B74：不在这里直接 throw——throw 会让 Promise.all 立即拒绝而其余 worker 继续跑完
            // 各自剩余的任务（每个都付费）；改为登记共享致命错误，循环入口统一退出。
            fatalError ??= e;
            return;
          }
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
  const anchorTask = pending.find((t) => t.kind === "anchor");
  if (anchorTask) {
    // B74：锚点走独立调用，视觉致命错误同样登记为共享状态（先收尾 flush，末尾统一抛出）
    try {
      const p = await runImageTask(cfg, anchorTask, cacheRoot, log, {
        materials,
        force: imageForceFor(anchorTask),
        isAborted,
        figureBase: result.figure,
        visualBible: approvedBible,
        outputDir: projectOutputDir,
        verifyCfg,
        negativePrompt: DEFAULT_NEGATIVE,
      });
      emitProgress(anchorTask);
      if (p) {
        anchorPath = p;
        generatedCount++;
      }
    } catch (e) {
      if (e instanceof VisionApiError) fatalError ??= e;
      else throw e;
    }
  } else {
    // 锚点命中缓存：静默解析路径供背景/CG 引用，不执行、不发进度
    const anchorDef = tasks.find((t) => t.kind === "anchor");
    if (anchorDef) {
      try {
        anchorPath = (await cacheHit(imageCacheDir, anchorDef.fileName)) ?? undefined;
      } catch {
        anchorPath = undefined;
      }
    }
  }
  if (isAborted?.()) {
    log({ step: "图像", message: "已中止（后续图片任务不再继续，已生成的保留）", level: "warn", at: Date.now() });
  } else if (!fatalError) {
    // B74：一旦出现视觉致命错误，后续 pass 不再启动（避免成批重复付费请求）
    await runPass(leadingPass, anchorPath);
    if (!fatalError) await runPass(firstPass, anchorPath);
    if (!fatalError) await runPass(emotionPass, anchorPath);
    if (!fatalError) await runPass(actionPass, anchorPath);
  }
  if (fatalError) {
    log({
      step: "图像",
      message: `视觉通道致命错误，已停止派发剩余图片任务（已生成的保留）：${errMsg(fatalError).slice(0, 160)}`,
      level: "error",
      at: Date.now(),
    });
  }

  // B68：函数结束前强制 flush（含中止/部分失败的分支）：已生成的图映射必须全部落盘，
  // 后续「组装」阶段与下次运行都依赖 assets.json 完整。
  if (assetFlushTimer !== null) {
    clearTimeout(assetFlushTimer);
    assetFlushTimer = null;
  }
  await flushAssetsNow();

  for (const chapter of chapters) {
    for (const scene of chapter.scenes) {
      scene.chapterOf = chapter.chapter;
      const bg = result.bg[scene.id];
      if (bg) scene.bgFile = bg;
      const cg = result.cg[scene.id];
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

  // B74：视觉致命错误在收尾（flush / 缓存绑定标记）完成后统一抛出，保持「仍向调用方抛出」的契约
  if (fatalError) throw fatalError;

  return { images: result, failed, generated: generatedCount };
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

export interface RepairImageReport {
  /** 剪掉的过期映射条目（当前剧本/卡片不再引用） */
  prunedRefs: number;
  /** 迁移的旧版 CG（映射键＋文件改名复用） */
  migratedCg: number;
  /** 删除的孤儿图片文件 */
  purgedFiles: number;
  /** 剪掉的"映射有、文件无"条目（下次运行自动补生成） */
  missingDropped: number;
  /** 是否因中断提前结束（映射变更可能只完成了一部分） */
  aborted: boolean;
}

const MANAGED_IMAGE_PREFIXES = ["bg_", "cg_", "figure_", "item_", "threeview_", "anchor_"];

/** 图片产物结构修复（一键清理无效素材）：
 * - 映射剪枝：只剪「调用方给出完整剧本/卡片」且能明确判定过期的条目；
 *   bg/cg 以剧本场景为准，人物/物品以 buildImageTasks 重建的当前任务 id 为准；
 *   未提供剧本/卡片的分区不剪（避免单章等不完整上下文误删）。
 * - 旧版 CG 迁移：映射键 cg_<章>_<scene> → <scene>，文件同步改名。
 * - 孤儿文件：images 目录下有管理前缀、但不被任何映射引用的文件删除。
 * - 缺文件条目：映射指向的文件已不存在 → 删条目（下次运行自动补生成）。
 * 图片/背景等其它产物不受影响。返回统计。 */
export async function repairImageAssets(
  outputDir: string,
  opts: {
    chapters?: ChapterScript[];
    cards?: ExtractionResult;
    figureEmotions?: boolean;
    figureDetail?: FigureDetail;
    threeView?: boolean;
    withActions?: boolean;
    cgPerChapter?: number;
    maxPerChapter?: number;
  },
  log: (ev: PipelineEvent) => void,
  isAborted?: () => boolean,
): Promise<RepairImageReport> {
  const report: RepairImageReport = { prunedRefs: 0, migratedCg: 0, purgedFiles: 0, missingDropped: 0, aborted: false };
  const cacheRoot = `${outputDir.replace(/[\\/]+$/, "")}/.novel2vn/cache`;
  const imageCacheDir = cacheDirFor(cacheRoot, "images");
  await tauri.mkdirAll(imageCacheDir);
  const map = await readAssetMap(outputDir);
  if (isAborted?.()) {
    report.aborted = true;
    log({ step: "图像", message: "清理无效素材已中断（未执行任何操作）", level: "warn", at: Date.now() });
    return report;
  }

  // 期望 key 集合（仅当调用方给出完整上下文时才用于剪枝）
  let bgKeep: Set<string> | null = null;
  let cgKeep: Set<string> | null = null;
  let figureKeep: Set<string> | null = null;
  let itemKeep: Set<string> | null = null;
  if (opts.chapters) {
    bgKeep = new Set();
    cgKeep = new Set();
    for (const ch of opts.chapters) {
      for (const s of ch.scenes) {
        bgKeep.add(s.id);
        if (s.cgEvent) cgKeep.add(s.id);
      }
    }
  }
  if (opts.cards) {
    const tasks = buildImageTasks(opts.chapters ?? [], opts.cards, {
      cgPerChapter: opts.cgPerChapter ?? 0,
      maxPerChapter: opts.maxPerChapter ?? 0,
      figureEmotions: opts.figureEmotions,
      detail: opts.figureDetail ?? "full",
      threeView: opts.threeView,
      actions: opts.withActions,
      // 必须覆盖全部动作：缺了会把第 3 个起的动作当过期剪映射、再当孤儿删文件
      maxActionsPerCharacter: 0,
    });
    figureKeep = new Set(tasks.filter((t) => t.kind === "figure" || t.kind === "threeview" || t.kind === "action").map((t) => t.id));
    itemKeep = new Set(tasks.filter((t) => t.kind === "item").map((t) => t.id));
  }

  const dropMissing = async (section: Record<string, string>): Promise<void> => {
    // 跨扩展名兼容：映射存 .png 而盘存 .jpg（API 常回 jpeg）不算缺失；
    // 找到变体时把映射修正到实际文件，避免误删映射。
    for (const [k, p] of Object.entries(section)) {
      if (isAborted?.()) return;
      try {
        if (await tauri.pathExists(p)) continue;
      } catch {
        /* 查询失败继续走变体检查 */
      }
      const base = p.replace(/\.(png|jpg|jpeg|webp)$/i, "");
      let fixed: string | null = null;
      for (const ext of ["png", "jpg", "jpeg", "webp"]) {
        const candidate = `${base}.${ext}`;
        if (candidate === p) continue;
        try {
          if (await tauri.pathExists(candidate)) {
            fixed = candidate;
            break;
          }
        } catch {
          /* ignore */
        }
      }
      if (fixed) {
        section[k] = fixed;
        continue;
      }
      delete section[k];
      report.missingDropped++;
    }
  };

  // 旧版 CG 映射键迁移：cg_<章>_<scene> → <scene>（场景仍存在才迁，否则按过期剪掉）。
  // 新键本身在保留集里时先认，避免数字开头的 scene.id（如 1_a）被当旧版误伤。
  for (const [k, p] of Object.entries(map.cg)) {
    if (cgKeep?.has(k)) continue;
    const m = /^(\d+)_(.+)$/.exec(k);
    if (!m) continue;
    const sceneId = m[2];
    if (cgKeep && !cgKeep.has(sceneId)) {
      delete map.cg[k];
      report.prunedRefs++;
      continue;
    }
    if (map.cg[sceneId] === undefined) {
      map.cg[sceneId] = p;
      report.migratedCg++;
    }
    delete map.cg[k];
  }

  if (bgKeep) for (const k of Object.keys(map.bg)) if (!bgKeep.has(k)) { delete map.bg[k]; report.prunedRefs++; }
  if (cgKeep) for (const k of Object.keys(map.cg)) if (!cgKeep.has(k) && !/^\d+_/.test(k)) { delete map.cg[k]; report.prunedRefs++; }
  if (figureKeep) for (const k of Object.keys(map.figure)) if (!figureKeep.has(k)) { delete map.figure[k]; report.prunedRefs++; }
  if (itemKeep) for (const k of Object.keys(map.item)) if (!itemKeep.has(k)) { delete map.item[k]; report.prunedRefs++; }

  await dropMissing(map.bg);
  await dropMissing(map.cg);
  await dropMissing(map.figure);
  await dropMissing(map.item);

  // 旧版 CG 文件改名：cg_<章>_<scene>.* → cg_<scene>.*（目标已存在则直接删旧文件）
  try {
    const entries = await tauri.listDir(imageCacheDir);
    for (const e of entries) {
      if (isAborted?.()) break;
      if (e.isDir) continue;
      const m = /^cg_\d+_(.+\.(png|jpg|jpeg|webp))$/i.exec(e.name);
      if (!m) continue;
      const target = `${imageCacheDir}/cg_${m[1]}`;
      try {
        if (await tauri.pathExists(target)) {
          await tauri.removePath(e.path).catch(() => {});
        } else {
          await tauri.copyFile(e.path, target);
          await tauri.removePath(e.path).catch(() => {});
        }
        report.migratedCg++;
      } catch {
        /* 迁移失败保留原文件 */
      }
    }
  } catch {
    /* 目录不存在等 */
  }

  // 孤儿文件：有管理前缀、但不被映射引用的删除。
  // 注意锚点 anchor_style.png 不在映射里（设计如此），必须排除，否则每次清理必误删画风基准。
  const referenced = new Set<string>();
  for (const section of [map.bg, map.cg, map.figure, map.item]) {
    for (const p of Object.values(section)) referenced.add((p.split(/[\\/]/).pop() || "").toLowerCase());
  }
  try {
    const entries = await tauri.listDir(imageCacheDir);
    for (const e of entries) {
      if (isAborted?.()) break;
      if (e.isDir) continue;
      const lower = e.name.toLowerCase();
      if (lower.startsWith("anchor_")) continue;
      // B69 的旁路参数元数据 `<图>.meta.json` 也带管理前缀，但它本就不在映射里，不能被当孤儿删掉
      if (lower.endsWith(".meta.json")) continue;
      if (!MANAGED_IMAGE_PREFIXES.some((pre) => lower.startsWith(pre))) continue;
      if (!referenced.has(lower)) {
        await tauri.removePath(e.path).catch(() => {});
        report.purgedFiles++;
      }
    }
  } catch {
    /* 目录不存在等 */
  }

  const aborted = isAborted?.() === true;
  report.aborted = aborted;
  await updateAssetMap(outputDir, (assets) => {
    assets.bg = map.bg;
    assets.cg = map.cg;
    assets.figure = map.figure;
    assets.item = map.item;
  });
  log({
    step: "图像",
    message: aborted
      ? `无效素材清理已中断：已完成部分（剪枝 ${report.prunedRefs} 项，迁移旧版 CG ${report.migratedCg} 项，删除孤儿文件 ${report.purgedFiles} 个，清理缺文件映射 ${report.missingDropped} 项）`
      : `无效素材清理完成：剪枝过期映射 ${report.prunedRefs} 项，迁移旧版 CG ${report.migratedCg} 项，删除孤儿文件 ${report.purgedFiles} 个，清理缺文件映射 ${report.missingDropped} 项（缺失项下次运行自动补生成）`,
    level: aborted ? "warn" : "success",
    at: Date.now(),
  });
  return report;
}
