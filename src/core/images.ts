import type {
  ChapterScript,
  CharacterCard,
  ExtractionResult,
  ImageTask,
  ItemCard,
  MaterialAsset,
  PipelineEvent,
  SceneJSON,
} from "./types";
import type { ApiConfig } from "./types";
import { generateImage } from "../api/openaiCompatible";
import { tauri } from "../utils/tauri";
import { cacheDirFor, cacheHit } from "./cache";
import { sanitizeId } from "./render";

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

export function buildImageTasks(
  chapters: ChapterScript[],
  cards: ExtractionResult,
  opts: { figurePerCharacter?: number; cgPerChapter?: number; maxPerChapter?: number; figureEmotions?: boolean },
): ImageTask[] {
  const tasks: ImageTask[] = [];
  const figurePerCharacter = opts.figurePerCharacter ?? 1;
  const cgPerChapter = opts.cgPerChapter ?? 3;
  const maxPerChapter = opts.maxPerChapter ?? 12;
  const useEmotions = opts.figureEmotions !== false;

  for (const char of cards.characters) {
    const emotions = useEmotions ? FIGURE_EMOTIONS : ["normal"];
    for (const emo of emotions) {
      const isNormal = emo === "normal";
      tasks.push({
        kind: "figure",
        id: isNormal ? char.id : `${char.id}_${emo}`,
        emotion: emo,
        prompt: char.imagePrompt + (EMOTION_PROMPT_SUFFIX[emo] ?? ""),
        referenceImage: isNormal ? char.referenceImage : undefined,
        refFromTask: isNormal ? undefined : char.id,
        fileName: `figure_${sanitizeId(char.id)}_${emo}.png`,
        width: 1024,
        height: 1024,
        usage: `立绘-${char.name}${isNormal ? "" : `（${emo}）`}`,
      });
    }
  }

  for (const item of cards.items) {
    tasks.push({
      kind: "item",
      id: item.id,
      prompt: item.imagePrompt,
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
        prompt: scene.bgPrompt || `${scene.location} ${scene.atmosphere}, anime background, no people`,
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
          prompt: scene.cgEvent.imagePrompt,
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
      message: `抠图失败，保留原图：${task.usage}（${(e as Error).message.slice(0, 100)}）`,
      level: "warn",
      at: Date.now(),
    });
    return path;
  }
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
): Promise<ImageResultMap> {
  const result: ImageResultMap = { bg: {}, cg: {}, figure: {}, item: {} };
  const tasks = buildImageTasks(chapters, cards, {
    figurePerCharacter: 1,
    cgPerChapter: 3,
    maxPerChapter: 12,
    figureEmotions,
  });

  const cacheDir = cacheDirFor(cacheRoot, "images");
  await tauri.mkdirAll(cacheDir);

  // 两阶段执行：先完成 normal 立绘与其他任务，再执行表情差分任务（以 normal 为参考图保持一致）
  const firstPass = tasks.filter((t) => t.kind !== "figure" || !t.emotion || t.emotion === "normal");
  const emotionPass = tasks.filter((t) => t.kind === "figure" && t.emotion && t.emotion !== "normal");

  let idx = 0;
  const runner = async () => {
    while (idx < tasks.length) {
      const task = tasks[idx++];
      await processTask(task);
    }
  };

  const processTask = async (task: ImageTask) => {
    // 表情差分任务：用已生成的 normal 立绘作为参考图（图生图保持一致）
    if (task.refFromTask && !task.referenceImage) {
      const basePath = result.figure[task.refFromTask];
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

    const cached = await cacheHit(cacheDir, task.fileName);
    if (cached) {
      path = cached;
      source = "缓存";
    } else {
      const mat = findMaterial(materials, task);
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
          return;
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
              message: `参考图失败，降级文生图：${task.usage}（${(e as Error).message.slice(0, 120)}）`,
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

    // 立绘/物品图自动抠出无背景透明底（失败自动降级保留原图）
    if (path && (task.kind === "figure" || task.kind === "item")) {
      path = await ensureCutout(path, task, log);
    }

    if (path) {
      const prefix = source === "缓存" ? "[缓存] " : source.startsWith("用户素材") ? `[用户素材] ` : "";
      log({ step: "图像", message: `${prefix}${task.usage}${source.startsWith("用户素材") ? ` <- ${source.replace("用户素材 ", "")}` : ""}`, level: "success", at: Date.now() });
      record(task, path);
    }
  };

  const record = (task: ImageTask, path: string) => {
    switch (task.kind) {
      case "background": result.bg[task.id] = path; break;
      case "cg": result.cg[task.id] = path; break;
      case "figure": result.figure[task.id] = path; break;
      case "item": result.item[task.id] = path; break;
    }
  };

  const workers = Array.from({ length: concurrency }, () => runner());
  // 第一阶段：普通立绘 + 背景/CG/物品
  tasks.length = 0;
  tasks.push(...firstPass);
  await Promise.all(workers);
  // 第二阶段：表情差分（normal 已完成，可作参考图）
  tasks.length = 0;
  tasks.push(...emotionPass);
  idx = 0;
  await Promise.all(workers);

  for (const chapter of chapters) {
    for (const scene of chapter.scenes) {
      scene.chapterOf = chapter.chapter;
      const bg = result.bg[scene.id];
      if (bg) scene.bgFile = bg;
      const cg = result.cg[`${chapter.chapter}_${scene.id}`];
      if (cg) scene.cgFile = cg;
    }
  }

  return result;
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
