import type {
  ChapterScript,
  CharacterCard,
  ExtractionResult,
  FailedTask,
  ImageTask,
  ItemCard,
  MaterialAsset,
  PipelineEvent,
  SceneJSON,
} from "./types";
import type { ApiConfig } from "./types";
import { generateImage } from "../api/openaiCompatible";
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

/** 图生图一致性提示：要求与参考图保持同一角色/服装/配色/画风/维度 */
const REF_HINT =
  ", exactly match the reference image: same character, same hair and eye color, same clothing and colors, same art style, same proportions, front-facing full body";

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

  for (const char of cards.characters) {
    // ① 三视图参考图（正/侧/背），作为该角色所有图像的图生图基准
    if (threeView) {
      tasks.push({
        kind: "threeview",
        id: `${char.id}_threeview`,
        prompt: (char.threeViewPrompt || threeViewFallback(char.imagePrompt)) + style,
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
        emotion: emo,
        prompt: char.imagePrompt + (EMOTION_PROMPT_SUFFIX[emo] ?? "") + REF_HINT + style + FIGURE_BG_SUFFIX,
        referenceImage: isNormal ? char.referenceImage : undefined,
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
        prompt: (scene.bgPrompt || `${scene.location} ${scene.atmosphere}, anime background, no people`) + style,
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
          prompt: scene.cgEvent.imagePrompt + style,
          fileName: `cg_${chapter.chapter}_${sanitizeId(scene.id)}.png`,
          width: 1024,
          height: 576,
          usage: `CG-${scene.cgEvent.title}`,
        });
        cgCount++;
      }
    }
  }

  return tasks;
}

async function tryCopyMaterial(mat: MaterialAsset, targetPath: string): Promise<boolean> {
  try {
    await tauri.copyFile(mat.path, targetPath);
    return true;
  } catch {
    return false;
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
    const out = await tauri.cutoutImage(b64, 40);
    const pngPath = path.replace(/\.(jpg|jpeg)$/i, ".png");
    await tauri.writeFileBase64(pngPath, out);
    if (pngPath !== path) {
      await tauri.removePath(path).catch(() => {});
    }
    log({ step: "图像", message: `无背景立绘：${task.usage}`, level: "info", at: Date.now() });
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
  /** 多模态模型自检：生成后核对图片是否符合描述，不合格自动重生成 1 次 */
  verifyCfg?: ApiConfig;
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
  // 表情差分任务：用已生成的 normal 立绘作为参考图（图生图保持一致）
  if (task.refFromTask && !task.referenceImage) {
    const basePath = opts.figureBase?.[task.refFromTask];
    if (basePath) {
      try {
        task.referenceImage = await tauri.readFileBase64(basePath);
      } catch {
        /* 读取失败则降级文生图 */
      }
    }
  }
  let path: string | null = null;
  let source = "";

  const cached = opts.force ? null : await cacheHit(cacheDir, task.fileName);
  if (cached) {
    path = cached;
    source = "缓存";
    logger.debug("images", "图像命中缓存", { id: task.id, fileName: task.fileName });
  } else {
    const mat = findMaterial(opts.materials ?? [], task);
    if (mat) {
      const ok = await tryCopyMaterial(mat, `${cacheDir}/${task.fileName}`);
      if (ok) {
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
      let img: { dataB64: string; mime: string };
      try {
        img = await generateImage(cfg, task.prompt, {
          referenceImageB64: task.referenceImage,
          size: `${task.width}x${task.height}`,
        });
      } catch (e) {
        if (task.referenceImage) {
          log({
            step: "图像",
            message: `参考图失败，降级文生图：${task.usage}（${errMsg(e).slice(0, 120)}）`,
            level: "warn",
            at: Date.now(),
          });
          img = await generateImage(cfg, task.prompt, { size: `${task.width}x${task.height}` });
        } else {
          throw e;
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

  // 多模态自检：核对图片是否符合描述，不合格自动重生成 1 次
  if (path && opts.verifyCfg && source === "AI 生成") {
    try {
      const b64 = await tauri.readFileBase64(path);
      const { ok, reason } = await verifyImage(opts.verifyCfg, b64, `${task.usage}；${task.prompt}`);
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
): Promise<{ images: ImageResultMap; failed: FailedTask[] }> {
  const result: ImageResultMap = { bg: {}, cg: {}, figure: {}, item: {} };
  const failed: FailedTask[] = [];
  const tasks = buildImageTasks(chapters, cards, {
    figurePerCharacter: 1,
    cgPerChapter: 3,
    maxPerChapter: 12,
    figureEmotions,
    style,
    feedback,
    threeView,
    actions: withActions,
  });

  await tauri.mkdirAll(cacheDirFor(cacheRoot, "images"));
  logger.info("images", "开始生成图像素材", {
    totalTasks: tasks.length,
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
    hasFeedback: !!feedback,
    style: style ? style.slice(0, 80) : "(默认)",
    concurrency,
  });

  // 四阶段执行（链式图生图保证形象一致）：
  // 三视图 → 默认立绘+背景/CG/物品 → 表情差分（以默认立绘为参考）→ 动作（以三视图为参考）
  const threeViewPass = tasks.filter((t) => t.kind === "threeview");
  const firstPass = tasks.filter((t) => (t.kind === "figure" && !t.emotion) || t.kind === "background" || t.kind === "cg" || t.kind === "item");
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
    }
  };

  const runPass = async (pass: ImageTask[]) => {
    let idx = 0;
    const worker = async () => {
      while (idx < pass.length) {
        const task = pass[idx++];
        try {
          const p = await runImageTask(cfg, task, cacheRoot, log, {
            materials,
            force,
            figureBase: result.figure,
            verifyCfg,
          });
          if (p) record(task, p);
        } catch (e) {
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

  await runPass(threeViewPass);
  await runPass(firstPass);
  await runPass(emotionPass);
  await runPass(actionPass);

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

  return { images: result, failed };
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
