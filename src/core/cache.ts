import type { ChapterScript, NovelDoc } from "./types";
import { tauri } from "../utils/tauri";
import { cleanPath } from "../utils/path";
import { log as logger } from "../utils/logger";

export function cacheDirFor(cacheRoot: string, section: string): string {
  return cleanPath(`${cacheRoot}/${section}`);
}

/**
 * 可落盘的图片扩展名全集。
 *
 * #1539：原先是 ["png","jpg","jpeg","webp"]，漏了 gif。但 detectedImageExtension 认得 GIF
 * （images.ts 的 `0x47 0x49 0x46` 分支），withDetectedExt 会把 API 返回的 GIF 字节改写成
 * `.gif` 落盘。于是命中链成了死循环：cacheHit(dir, "cg_1_x.png") 精确未命中 → 按 basename
 * 探测四种扩展名 → 磁盘上是 .gif，全都找不到 → 每次重跑都重新生成、重新付费。
 * 这正是本函数当初要解决的那类问题（注释里写的「用户报告每次都要重新生成」），只是漏了一种格式。
 * project.ts 的 stripExt 早已把 gif 算进去，也印证了 gif 确实会落到磁盘上。
 */
export const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif"] as const;

/** 去掉图片扩展名（大小写不敏感）；无已知扩展名时原样返回。与 IMAGE_EXTS 严格同源。 */
export function stripImageExt(fileName: string): string {
  return fileName.replace(/\.(png|jpg|jpeg|webp|gif)$/i, "");
}

/**
 * 缓存命中：优先精确文件名；否则按 basename 匹配常见图片扩展名（.png/.jpg/.jpeg/.webp）。
 * 原因：图像 API 可能返回 jpeg/webp（task.fileName 固定 .png），若只查 .png 会导致
 * 已生成的 .jpg 图无法命中缓存，每次重跑都重新生成（用户报告「每次都要重新生成」）。
 */
export async function cacheHit(dir: string, fileName: string): Promise<string | null> {
  const path = `${dir}/${fileName}`;
  try {
    if (await tauri.pathExists(path)) return path;
  } catch {
    /* ignore */
  }
  const base = stripImageExt(fileName);
  for (const ext of IMAGE_EXTS) {
    const candidate = `${dir}/${base}.${ext}`;
    if (candidate === path) continue;
    try {
      if (await tauri.pathExists(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 短标题哈希（缓存文件名用，非加密） */
export function titleHash(title: string): string {
  let h = 5381;
  for (const ch of title) {
    h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  }
  return h.toString(36);
}

interface ScriptFingerprintInput {
  /** 剧本文风：留空不调整 */
  style?: string;
  /** 旁白压缩开关（#801）：开=精简提炼旁白；关（默认）=忠实保留全文旁白 */
  compressNarration?: boolean;
  /** 视觉模式（sprite=立绘版；imageOnly=图片小说）：进入指纹，保证两套页面缓存互不命中（#808） */
  visualMode?: string;
  /** 卡片指纹（cardsFingerprint）：重新提取导致角色/物品/场景 id 变化时旧剧本必须失效。
   *  否则渲染时按 id 找不到角色卡，人名会退化成内部 id（用户实测：游戏里显示 ouiriseri: 这类 id）。 */
  cardsFp?: string;
}

/**
 * 卡片指纹（脚本缓存键用）：角色/物品/场景的 id+名称排序后哈希。
 * 只含 id 与展示名——外貌/性格微调不影响剧本引用，不必触发重写。
 */
export function cardsFingerprint(cards: {
  characters?: { id: string; name?: string }[];
  items?: { id: string; name?: string }[];
  scenes?: { id: string; location?: string }[];
}): string {
  const parts: string[] = [];
  for (const c of cards.characters ?? []) parts.push(`c:${c.id}:${c.name ?? ""}`);
  for (const i of cards.items ?? []) parts.push(`i:${i.id}:${i.name ?? ""}`);
  for (const s of cards.scenes ?? []) parts.push(`s:${s.id}:${s.location ?? ""}`);
  parts.sort();
  return titleHash(parts.join("|"));
}

/**
 * 剧本缓存指纹（唯一实现，#802）：文风 + 旁白压缩开关 + 视觉模式 + 卡片指纹。
 * 此前公式 `style ? "_st" + titleHash(style) : ""` 在管线/看板/章节灯/核对共 7 处复制，
 * 新增任何剧本参数都可能漏改一处导致「看板绿灯但产物是旧的」或「永远重跑」；
 * 所有调用点必须改为调用本函数（旧字符串入参仍兼容）。
 */
export function scriptFingerprint(input: ScriptFingerprintInput | string | undefined): string {
  const opts: ScriptFingerprintInput = typeof input === "string" ? { style: input } : (input ?? {});
  const parts: string[] = [];
  const style = (opts.style ?? "").trim();
  if (style) parts.push(`_st${titleHash(style)}`);
  if (opts.compressNarration) parts.push("_cn1");
  const mode = (opts.visualMode ?? "sprite").trim() || "sprite";
  if (mode !== "sprite") parts.push(`_vm${titleHash(mode)}`);
  if (opts.cardsFp) parts.push(`_cd${opts.cardsFp}`);
  return parts.join("");
}

/** 剧本缓存键后半段（标题哈希＋正文全文指纹＋文风）。
 * 正文必须取全文哈希：旧实现只取前 8000 字，超长章后半改动检测不到、误命中旧剧本。 */
export function scriptCacheRest(title: string, text: string, styleFrag: string): string {
  return `${titleHash(title)}_t${titleHash(text || "")}${styleFrag}`;
}

/** 剧本缓存文件名：与管线 scriptWorker 的 cacheFile 公式唯一对应，供管线内外复用 */
export function scriptCacheFileName(
  cacheDir: string,
  demo: boolean,
  chapterIndex: number,
  title: string,
  text: string,
  styleFrag: string,
): string {
  return `${cacheDir}/${demo ? "script_demo" : "script"}_ch${chapterIndex + 1}_${scriptCacheRest(title, text, styleFrag)}.json`;
}

/**
 * 段缓存 rest（P1 分段落盘/断点续跑）：整章 rest 口径 + 意见指纹。
 * 带意见重写必须换键——否则会复用上一版提示词跑出的旧段（与整章缓存「有意见时跳过缓存」的口径对齐）。
 */
export function scriptPartRest(title: string, text: string, styleFrag: string, feedback?: string): string {
  const fb = (feedback ?? "").trim();
  return scriptCacheRest(title, text, `${styleFrag}${fb ? `_fb${titleHash(fb)}` : ""}`);
}

/** 段缓存文件名：沿用整章缓存的目录与命名习惯，插入 part<K>of<T> 段标记 */
export function scriptPartFileName(
  cacheDir: string,
  demo: boolean,
  chapterIndex: number,
  title: string,
  text: string,
  styleFrag: string,
  feedback: string | undefined,
  part: number,
  total: number,
): string {
  return `${cacheDir}/${demo ? "script_demo" : "script"}_ch${chapterIndex + 1}_part${part}of${total}_${scriptPartRest(title, text, styleFrag, feedback)}.json`;
}

/** 是否为段缓存文件（整章缓存扫描必须排除它：它的 rest 带 part 前缀，按整章口径必判 stale，会误删断点） */
export function isScriptPartFileName(name: string): boolean {
  return /^script(_demo)?_ch\d+_part\d+of\d+_.+\.json$/.test(name || "");
}

/* ==================== 骨架小说标记（剧本缓存兜底产物） ==================== */

/**
 * #1509 骨架小说：源文件与 split.json 都不可用时，用剧本缓存的章节标题+序号造出的占位正文。
 *
 * 为什么必须有显式标记：`restoreNovelFromScriptCache` 造的正文是
 * 「（第 N 章：分章缓存缺失，仅保留章节骨架；可重新导入小说以恢复原文）」这类占位串，
 * 但它和真原文在数据结构上完全一样。没有标记时，用户点「开始生成」会把占位串当成小说正文
 * 送去做 AI 分章/提取/剧本（真实计费），并把 split.json 整份覆写成垃圾——
 * 而 split.json 往往是原文正文的最后一处副本。原注释只写了「依赖原文的重新分章仍会提示重新导入」，
 * 但仓库里没有任何判定，承诺从未落地。
 *
 * 标记用 NovelDoc 上的可选字段承载（types.ts 不在本次改动范围内，故在此声明该可选字段的形状；
 * 待 types.ts 可改时把它并入 NovelDoc 即可，读写口径不变）。
 */
export type NovelDocWithSkeleton = NovelDoc & { skeleton?: boolean };

/** 给小说打骨架标记（返回同一对象，便于链式使用） */
export function markSkeletonNovel(novel: NovelDoc): NovelDoc {
  (novel as NovelDocWithSkeleton).skeleton = true;
  return novel;
}

/** 是否为骨架小说（正文是占位串，不是真原文）。任何依赖原文的生成都必须据此拦截。 */
export function isSkeletonNovel(novel: NovelDoc | null | undefined): boolean {
  return !!novel && (novel as NovelDocWithSkeleton).skeleton === true;
}

/** 骨架小说的拦截文案（管线与界面共用，保证口径一致） */
export const SKELETON_NOVEL_MESSAGE =
  "当前小说的正文是「分章缓存缺失」的占位骨架（不是原文），不能用于生成：请重新导入小说后再运行。";

/* ==================== 章节键映射（novel index → 实际 scene/voice 键） ==================== */

/**
 * 管线只在内存里做「章节重编号 + 跨章场景 id 去重」（pipeline 的
 * `chapters.forEach((c, i) => c.chapter = i)` 与 `dedupeSceneIdsAcrossChapters`），
 * 而磁盘上的剧本缓存保存的是**novel index + 去重前的 scene.id**。
 *
 * 于是所有「从磁盘重新算键」的下游都会算错键：
 *   - 素材页单句重配（regenerate.buildVoiceJobs 用恢复出来的 chapter.chapter 重建 job）→ 找不到 job，付费按钮点了没反应；
 *   - 章节灯（useChapterStatus）用去重前的 id 查映射 → 命中**别章**的背景图，误判「本章已完成」，队列永不补这一章；
 *   - 停用章剪枝保留集 → 与映射键口径不一致，停用再启用后缺背景/无配音。
 *
 * 根因是这份映射没有落盘。本文件负责把它读写为 `.novel2vn/chapter-keys.json`，
 * 并导出「按映射改写 scene.id」的纯函数，供所有消费者统一取键。
 */
export interface ChapterKeysFile {
  version: 1;
  /** 生成这份映射时的小说指纹（源路径 + 各章正文哈希）：原文变了映射必须作废 */
  novelFp: string;
  /** 是否为演示模式（demo 与正式两套产物键空间不同，必须隔离） */
  demo: boolean;
  /** novel index → 该章在本次运行中的位置（0-based，即章节/配音键里的章节号） */
  posByIndex: Record<string, number>;
  /** novel index → 该章在内存里去重后的 scene.id 列表（顺序与场景一致） */
  sceneIdsByIndex: Record<string, string[]>;
  /** 位置 → 该位置的配音键全集（含长台词分段 _pN），供按键反查的消费者使用 */
  vocalKeysByPos: Record<string, string[]>;
  at: string;
}

export function chapterKeysFile(outputDir: string): string {
  return cleanPath(`${outputDir}/.novel2vn/chapter-keys.json`);
}

/** 空映射（读不到文件时的安全默认值）：所有查询都退化为「按磁盘原样」 */
export function emptyChapterKeys(): ChapterKeysFile {
  return { version: 1, novelFp: "", demo: false, posByIndex: {}, sceneIdsByIndex: {}, vocalKeysByPos: {}, at: "" };
}

/**
 * 读章节键映射：文件不存在返回 null（调用方按「无映射」退化），损坏返回 null 并 warn。
 * 不抛错：它服务于界面灯具与素材页，读不出来只应退化成旧行为，不该让页面整块失败。
 */
export async function readChapterKeys(outputDir: string): Promise<ChapterKeysFile | null> {
  try {
    const file = chapterKeysFile(outputDir);
    if (!(await tauri.pathExists(file))) return null;
    const { text } = await tauri.readTextFile(file);
    const parsed = JSON.parse(text) as Partial<ChapterKeysFile> | null;
    if (!parsed || typeof parsed !== "object" || !parsed.posByIndex || typeof parsed.posByIndex !== "object") return null;
    return {
      version: 1,
      novelFp: typeof parsed.novelFp === "string" ? parsed.novelFp : "",
      demo: parsed.demo === true,
      posByIndex: parsed.posByIndex as Record<string, number>,
      sceneIdsByIndex: (parsed.sceneIdsByIndex ?? {}) as Record<string, string[]>,
      vocalKeysByPos: (parsed.vocalKeysByPos ?? {}) as Record<string, string[]>,
      at: typeof parsed.at === "string" ? parsed.at : "",
    };
  } catch (e) {
    logger.warn("cache", "chapter-keys.json 解析失败，本次按「无映射」处理（键可能错位，重跑一次剧本阶段即可重建）", {
      outputDir,
      error: String(e).slice(0, 160),
    });
    return null;
  }
}

export async function writeChapterKeys(outputDir: string, keys: ChapterKeysFile): Promise<void> {
  await tauri.writeTextFile(chapterKeysFile(outputDir), JSON.stringify(keys, null, 2));
}

/** 取某章的落盘场景 id 列表（无映射时返回 undefined，调用方保持原样） */
export function chapterSceneIdsFor(keys: ChapterKeysFile | null, novelIndex: number): string[] | undefined {
  if (!keys) return undefined;
  const ids = keys.sceneIdsByIndex?.[String(novelIndex)];
  return Array.isArray(ids) ? ids : undefined;
}

/** 取某章在本次运行中的位置（配音/章节键里的章节号）；无映射返回 undefined */
export function chapterPositionFor(keys: ChapterKeysFile | null, novelIndex: number): number | undefined {
  if (!keys) return undefined;
  const pos = keys.posByIndex?.[String(novelIndex)];
  return Number.isInteger(pos) ? pos : undefined;
}

/**
 * 按映射改写 scene.id（纯函数，不改入参）。
 *
 * 只按**顺序**替换，不按 id 值匹配：磁盘剧本里的 s3 与内存去重后的 s3_2 是同一场景，
 * 位置是两者唯一可靠的对应关系（LLM 输出的场景顺序不会在去重时变化）。
 * 数量不一致（映射比剧本旧/新）时整章放弃改写——宁可退化成旧行为，也不要错位覆盖，
 * 那会把别章的背景图当成自己的（正是本映射要修的故障）。
 */
export function applyChapterKeySceneIds(
  chapter: ChapterScript,
  sceneIds: string[] | undefined,
): ChapterScript {
  if (!sceneIds || sceneIds.length !== chapter.scenes.length) return chapter;
  return {
    ...chapter,
    scenes: chapter.scenes.map((scene, i) => (scene.id === sceneIds[i] ? scene : { ...scene, id: sceneIds[i] })),
  };
}

/**
 * 把「磁盘形态」的章节列表对齐到产出键（位置 + 去重后 scene.id）；不适用时**原样返回**。
 *
 * 为什么需要它：从磁盘恢复的剧本里 `chapter` 是 novel index、`scene.id` 是去重前的（LLM 每章都输出
 * s1/s2…，去重后第 2 章的 s1 实际是 s1_2），而 `assets.json` 里的配音/图片键是**产出形态**。
 * 直接用磁盘形态建 job 会算出不存在的键 → 素材页「重配」返回 null（点了没反应）、
 * 看板把已存在的配音判成缺失（诱导用户重复付费合成）。
 *
 * 适用判据：`posByIndex` 必须覆盖**每一个** chapter 值。磁盘形态一定被覆盖（键就是 novel index）；
 * 而已经对齐过的形态里 chapter 是位置，只要有停用章就会出现「某个位置值不在 posByIndex 里」的缺口，
 * 此时整体放弃 —— 宁可退化成旧行为，也不要二次映射把键错到别章（那正是本映射要修的故障）。
 */
export function alignChaptersToKeys(
  chapters: ChapterScript[],
  keys: ChapterKeysFile | null,
): ChapterScript[] {
  if (!keys || !chapters.length) return chapters;
  const covered = chapters.every((c) => Number.isInteger(keys.posByIndex?.[String(c.chapter)]));
  if (!covered) return chapters;
  // 恒等映射（位置 == novel index 且场景 id 也一致）时直接返回原数组，避免无谓的对象拷贝
  const identity = chapters.every((c) => keys.posByIndex[String(c.chapter)] === c.chapter)
    && chapters.every((c) => {
      const ids = keys.sceneIdsByIndex?.[String(c.chapter)];
      return !Array.isArray(ids) || (ids.length === c.scenes.length && ids.every((id, i) => id === c.scenes[i].id));
    });
  if (identity) return chapters;
  return chapters.map((c) => {
    const pos = chapterPositionFor(keys, c.chapter);
    const aligned = applyChapterKeySceneIds(c, chapterSceneIdsFor(keys, c.chapter));
    return pos === undefined || pos === c.chapter ? aligned : { ...aligned, chapter: pos };
  });
}

/** 解析段缓存文件名（纯函数，供单测与断点扫描）：失败返回 null */
export function parseScriptPartFileName(name: string): {
  demo: boolean;
  chapterPos: number;
  part: number;
  total: number;
  rest: string;
} | null {
  const m = /^script(_demo)?_ch(\d+)_part(\d+)of(\d+)_(.+)\.json$/.exec(name || "");
  if (!m) return null;
  return {
    demo: !!m[1],
    chapterPos: parseInt(m[2], 10) - 1,
    part: parseInt(m[3], 10),
    total: parseInt(m[4], 10),
    rest: m[5],
  };
}

interface ScriptPartScanResult {
  /** 段号(1-based) → 文件路径：rest 与总数都匹配、可直接复用 */
  hits: Map<number, string>;
  /** 同章同模式但 rest/总数失配的旧段文件路径：调用方删除（只删本章的段文件） */
  stale: string[];
}

/**
 * 段缓存扫描（纯函数，供单测）：按章序号+模式隔离，按 rest+总数判定命中/过期。
 * 非段文件、别章文件直接忽略（不断言、不删除）。
 */
export function scanScriptPartCache(
  entries: { name: string; path: string }[],
  chapterIndex: number,
  demo: boolean,
  expectedRest: string,
  expectedTotal: number,
): ScriptPartScanResult {
  const hits = new Map<number, string>();
  const stale: string[] = [];
  for (const e of entries) {
    const p = parseScriptPartFileName(e.name);
    if (!p) continue;
    if (p.chapterPos !== chapterIndex || p.demo !== demo) continue;
    if (
      p.rest === expectedRest
      && p.total === expectedTotal
      && Number.isInteger(p.part)
      && p.part >= 1
      && p.part <= expectedTotal
      && !hits.has(p.part)
    ) {
      hits.set(p.part, e.path);
    } else {
      stale.push(e.path);
    }
  }
  return { hits, stale };
}
