import type {
  ApiConfig,
  AssetMap,
  ChapterInfo,
  ChapterScript,
  CostStats,
  ExtractionResult,
  FailedTask,
  GenerationOptions,
  MaterialAsset,
  NovelDoc,
  PipelineEvent,
  PipelineResult,
  ProjectMeta,
  ProjectVisualBible,
  StageFeedback,
  StageKey,
} from "./types";
import { STAGE_ORDER, languageName } from "./types";
import type { RenderAssets, WebgalLanguage } from "./render";
import { sanitizeId } from "./render";
import { extractFromNovel, demoExtract } from "./extract";
import { extractFromNovelAgent, mergeCharacter, normalizeName } from "./extractAgent";
import { scriptChapter, demoScriptAll, verifyScriptAgainstSource } from "./script";
import { translateChapter } from "./translate";
import { aiSplitChapters, splitChaptersForFallback } from "./split";
import type { SplitStats } from "./split";
import { generateImages } from "./images";
import { generateVoice, vocalKeysForChapters } from "./voice";
import { assembleProject, gameKeyFor } from "./project";
import { cacheDirFor, titleHash, scriptCacheRest, scriptCacheFileName } from "./cache";
export { titleHash, scriptCacheRest, scriptCacheFileName };
import { tauri } from "../utils/tauri";
import { errMsg } from "../utils/errors";
import { classifyError } from "../utils/errorClassifier";
import { log as logger } from "../utils/logger";
import { configIsUsable } from "../api/providers";
import { concurrencyFor } from "../stores/configMigration";
import { setLlmConcurrency } from "../api/openaiCompatible";
import { assertVisualBibleApprovalStatus, assertVisualBibleReadyForImages } from "./visualBible";
import { readAssetMap, updateAssetMap } from "./assetMap";
import { parseChapterScript } from "./dataValidation";

export interface PipelineInput {
  novel: NovelDoc;
  cards?: ExtractionResult;
  llm?: ApiConfig;
  vision?: ApiConfig;
  image?: ApiConfig;
  tts?: ApiConfig;
  visualBible?: ProjectVisualBible;
  materials: MaterialAsset[];
  outputDir: string;
  templateDir: string;
  options: GenerationOptions;
  log: (ev: PipelineEvent) => void;
  /** 本次要执行的阶段（默认全部）。未勾选的阶段从磁盘缓存/产物读取，供分阶段生成 */
  stages?: StageKey[];
  /** 各阶段重生成意见，重跑该阶段时注入给 LLM */
  feedback?: StageFeedback;
  /** 强制重跑且跳过缓存的阶段（如「重新剧本/重新图像/重新配音」），即使没有意见也生效 */
  forceStages?: StageKey[];
  /**
   * 单章节模式保护：为 true 时，若有已启用章节因无剧本缓存被跳过，
   * 在组装前直接抛错（避免组装删掉已有章节的游戏文件导致游戏缩水）。
   * 由单章节重跑/队列调用，普通全量流程不传。
   */
  requireFullScriptCoverage?: boolean;
  /**
   * 纯追加式增量加更：baseFullText 为已生成部分的原文全文，tailText 为新增章节原文。
   * 要求 split.json 缓存指纹与 baseFullText 一致；旧章节/卡片/素材全部保留，
   * 只对新增部分分章→增量提取→生成新章。需要 stages 包含 split+extract+script。
   */
  append?: { baseFullText: string; tailText: string };
}

export const DEFAULT_PRICES = {
  llmInYuanPer1m: 2,
  llmOutYuanPer1m: 8,
  imageYuanEach: 0.3,
  ttsYuanPer1mChars: 500,
};

/**
 * LLM 文本错误是否值得自动重试：网络/限流/5xx/服务端临时/JSON 解析类可重试；
 * 参数/鉴权/模型不存在等配置类错误不重试（避免浪费调用）。
 */
/**
 * LLM 文本调用失败自动重试：错误分类驱动（网络/限流/未知退避重试；鉴权/参数/中止/内容审查直接失败）+ 递增间隔（1s→10s→…→60s）。
 */
async function withTextRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; isAborted?: () => boolean; onRetry?: (attempt: number, delayMs: number, err: unknown) => void },
): Promise<T> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    if (opts.isAborted?.()) throw new Error("已中止");
    try {
      return await fn();
    } catch (e) {
      const cls = classifyError(e);
      // 硬失败（鉴权/参数/中止）与内容审查 → 不重试直接抛出
      if (cls === "auth" || cls === "invalid_param" || cls === "aborted" || cls === "content_moderation") throw e;
      if (attempt >= retries) throw e;
      // 网络/限流/未知 → 递增退避（首次 1s、二次 10s、之后每次 +10s，封顶 60s）
      const delay = attempt === 0 ? 1000 : Math.min(60_000, attempt * 10_000);
      opts.onRetry?.(attempt + 1, delay, e);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** 追加拼接原文：已生成部分（去尾空白）+ 分隔空行 + 新增部分（去首尾空白） */
export function joinAppendText(baseFullText: string, tailText: string): string {
  return `${baseFullText.replace(/\s+$/, "")}\n\n\n${tailText.replace(/^\s+/, "").replace(/\s+$/, "")}`;
}

/** 小说全文指纹：源路径 + 正文内容哈希，用于分章/卡片缓存作废判断 */
export function novelFingerprint(fullText: string): string {
  let h = 5381;
  for (const ch of fullText) {
    h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  }
  return `${fullText.length}:${h.toString(36)}`;
}

/** 小说正文指纹（分隔符不敏感）：拼接各章正文后整体哈希。
 * AI 重分章只改切分点、不改文字时指纹不变——旧实现用带分隔符 join，
 * 切分点一动就误判"小说内容变化"并删掉整个图片/配音缓存。 */
export function novelBodyFingerprint(texts: (string | undefined | null)[]): string {
  let h = 5381;
  for (const t of texts) {
    const s = t || "";
    for (const ch of s) {
      h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
    }
  }
  return h.toString(36);
}

/** 分章入口：有 LLM 用 AI 分章，无 LLM 用规则回退（调用方据此记录分章来源） */
export type SplitMethod = "ai" | "fallback";
async function splitNovelForPipeline(
  cfg: ApiConfig | undefined,
  fullText: string,
  onUsage?: (pt: number, ct: number) => void,
  feedback?: string,
  concurrency = 3,
  out?: { method?: SplitMethod; stats?: SplitStats },
): Promise<ChapterInfo[]> {
  if (!cfg?.apiKey) {
    if (out) out.method = "fallback";
    return splitChaptersForFallback(fullText);
  }
  if (out) out.method = "ai";
  const stats: SplitStats = {};
  const chapters = await aiSplitChapters(cfg, fullText, onUsage, 40000, feedback, concurrency, stats);
  if (out) out.stats = stats;
  return chapters;
}

/** 图片固定种子：用户指定则用之；否则按标题稳定派生，保证同一项目多次生成风格一致 */
export function imageSeedFor(title: string, opts: GenerationOptions): number | undefined {
  if (opts.imageSeed && opts.imageSeed > 0) return Math.floor(opts.imageSeed);
  let h = 5381;
  for (const ch of title) {
    h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  }
  return h % 2147483647;
}

// 章节内场景 id 去重：LLM 可能输出重复 id，会导致背景图/配音/BGM 互相覆盖。
// 幂等：重复 id 追加 _2/_3 后缀；已带后缀的不重复处理。
export function ensureUniqueSceneIds(script: ChapterScript): void {
  const seen = new Map<string, number>();
  for (const scene of script.scenes) {
    const base = scene.id || "s";
    const count = seen.get(base) ?? 0;
    if (count > 0) {
      scene.id = `${base}_${count + 1}`;
    }
    seen.set(base, count + 1);
  }
}

/** 跨章场景 id 唯一化：LLM 不同章都可能输出 s1/s2…，同名会导致背景图/配音/BGM 互相覆盖
 * （实测 92 个背景任务挤进 6 个文件）。在整批章节收集完成后调用一次，确保全局唯一。
 * 幂等：首次出现的 id（含已带 _数字 后缀）原样保留；冲突时剥掉旧数字后缀后递增，保证 s1_2 冲突得 s1_3 而非 s1_2_2。 */
export function dedupeSceneIdsAcrossChapters(chapters: ChapterScript[]): void {
  const used = new Set<string>();
  for (const chapter of chapters) {
    for (const scene of chapter.scenes) {
      const raw = scene.id || "s";
      if (!used.has(raw)) {
        used.add(raw);
        scene.id = raw;
        continue;
      }
      const stem = raw.replace(/_\d+$/, "") || "s";
      let n = 2;
      while (used.has(`${stem}_${n}`)) n++;
      used.add(`${stem}_${n}`);
      scene.id = `${stem}_${n}`;
    }
  }
}

/** 映射剪枝（纯函数，就地删除）：删掉当前剧本不再引用的 bg/cg/vocal 旧条目；
 * 旧版 CG 键 cg_<章>_<scene> 若场景仍存在则迁移为新键 <scene>，否则删除。
 * 人物/物品键无法仅凭剧本判定归属，留给 repairImageAssets（需卡片上下文）处理。 */
export function pruneAssetRefs(
  assets: { bg: Record<string, string>; cg: Record<string, string>; vocal: Record<string, string> },
  chapters: ChapterScript[],
): { bg: number; cg: number; cgMigrated: number; vocal: number } {
  const stat = { bg: 0, cg: 0, cgMigrated: 0, vocal: 0 };
  const bgKeep = new Set<string>();
  const cgKeep = new Set<string>();
  for (const ch of chapters) {
    for (const s of ch.scenes) {
      bgKeep.add(s.id);
      if (s.cgEvent) cgKeep.add(s.id);
    }
  }
  for (const k of Object.keys(assets.bg)) {
    if (!bgKeep.has(k)) { delete assets.bg[k]; stat.bg++; }
  }
  for (const [k, v] of Object.entries(assets.cg)) {
    const legacy = /^(\d+)_(.+)$/.exec(k);
    if (legacy) {
      const sceneId = legacy[2];
      if (cgKeep.has(sceneId)) {
        if (assets.cg[sceneId] === undefined) {
          assets.cg[sceneId] = v;
          stat.cgMigrated++;
        }
      } else {
        stat.cg++;
      }
      delete assets.cg[k];
      continue;
    }
    if (!cgKeep.has(k)) { delete assets.cg[k]; stat.cg++; }
  }
  const vocalKeep = new Set(vocalKeysForChapters(chapters));
  for (const k of Object.keys(assets.vocal)) {
    if (!vocalKeep.has(k)) { delete assets.vocal[k]; stat.vocal++; }
  }
  return stat;
}

/** 增量卡片合并（纯追加）：老卡片为底，新增部分提取结果按归一化姓名并入。
 * 同名角色视为同一人（老 id/字段保留、缺字段补齐、动作并集）；
 * 新角色/场景/物品 id 若与老 id 冲突则加后缀避让。返回合并结果与新增统计。 */
export function mergeAppendedCards(
  oldCards: ExtractionResult,
  freshCards: ExtractionResult,
): { merged: ExtractionResult; addedCharacters: string[]; addedScenes: number; addedItems: number } {
  const merged: ExtractionResult = {
    ...oldCards,
    characters: oldCards.characters.map((c) => ({ ...c })),
    scenes: oldCards.scenes.map((s) => ({ ...s })),
    items: oldCards.items.map((i) => ({ ...i })),
  };
  const addedCharacters: string[] = [];
  const usedIds = new Set<string>([
    ...merged.characters.map((c) => c.id),
    ...merged.scenes.map((s) => s.id),
    ...merged.items.map((i) => i.id),
  ]);
  const uniqueId = (want: string): string => {
    let id = want || "x";
    let n = 2;
    while (usedIds.has(id)) id = `${want || "x"}_x${n++}`;
    usedIds.add(id);
    return id;
  };
  const oldByName = new Map<string, (typeof merged.characters)[number]>();
  for (const c of merged.characters) {
    const key = normalizeName(c.name);
    if (key && !oldByName.has(key)) oldByName.set(key, c);
  }
  for (const fc of freshCards.characters) {
    const hit = normalizeName(fc.name) ? oldByName.get(normalizeName(fc.name)) : undefined;
    if (hit) {
      mergeCharacter(hit, { ...fc, id: hit.id });
    } else {
      merged.characters.push({ ...fc, id: uniqueId(fc.id) });
      addedCharacters.push(fc.name || fc.id);
    }
  }
  let addedScenes = 0;
  for (const fs of freshCards.scenes) {
    merged.scenes.push({ ...fs, id: uniqueId(fs.id) });
    addedScenes++;
  }
  let addedItems = 0;
  for (const fi of freshCards.items) {
    merged.items.push({ ...fi, id: uniqueId(fi.id) });
    addedItems++;
  }
  return { merged, addedCharacters, addedScenes, addedItems };
}

export class Pipeline {
  private cost: CostStats = {
    llmTokens: 0,
    imageCount: 0,
    ttsChars: 0,
    llmCostYuan: 0,
    imageCostYuan: 0,
    ttsCostYuan: 0,
  };
  private cacheRoot = "";
  private aborted = false;
  private failedTasks: FailedTask[] = [];
  private onUsageCb?: (pt: number, ct: number) => void;
  /** 图像阶段是否有任务失败（中断/429/400）。失败时跳过组装，避免产出缺图残次品。 */
  private imageHadFailures = false;
  /** 最终剧本数组位置 → novel 原始 index 的映射（剧本收集后、重编号前记录；供图像/配音分章节过滤） */
  private activeChapterIndexes: number[] = [];
  /** 本次运行的分章来源与丢弃数（供结果透出与 UI 展示） */
  private lastSplitMethod: SplitMethod | "legacy" | "import" | undefined;
  private lastSplitDiscarded = 0;
  /** 本次运行中因无缓存被跳过的章节标题（单章节模式组装前保护用） */
  private skippedScriptChapters: string[] = [];
  /** 纯追加模式新增章节的 novel index（分章后赋值；供剧本/图像/配音自动限定只跑新章） */
  private appendedIndexes: number[] = [];

  constructor(private input: PipelineInput) {}

  abort(): void {
    this.aborted = true;
  }

  private recordFailure(f: FailedTask): void {
    this.failedTasks.push(f);
    this.input.log({
      step: f.step,
      message: `失败（可在「失败项」查看重试）：${f.message}`,
      level: "error",
      at: f.at,
      taskId: f.id,
      taskKind: f.kind,
    });
    // 增量落盘：中断/崩溃/重启后「失败项」仍可恢复
    void this.persistFailedTasks();
  }

  /** 当前失败的只读快照（供中止/异常路径回填 UI，避免失败列表丢失） */
  getFailedTasks(): FailedTask[] {
    return this.failedTasks.slice();
  }

  private failedFile(): string {
    return `${this.input.outputDir}/.novel2vn/failed.json`;
  }

  private async persistFailedTasks(): Promise<void> {
    try {
      await tauri.writeTextFile(this.failedFile(), JSON.stringify(this.failedTasks, null, 2));
    } catch {
      /* 失败列表落盘失败不阻断 */
    }
  }

  private log(msg: string, level: PipelineEvent["level"] = "info", step = "管线"): void {
    this.input.log({ step, message: msg, level, at: Date.now() });
  }

  private get options(): GenerationOptions {
    return this.input.options;
  }

  private get feedback(): StageFeedback {
    return this.input.feedback ?? {};
  }

  private async readCachedJson<T>(file: string): Promise<T | null> {
    try {
      if (await tauri.pathExists(file)) {
        const { text } = await tauri.readTextFile(file);
        return JSON.parse(text) as T;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /* ---------- 从磁盘恢复中间产物（供分阶段运行） ---------- */

  private async loadCards(): Promise<ExtractionResult | null> {
    const base = `${this.input.outputDir}/.novel2vn`;
    for (const f of ["cards.json", "cards_demo.json"]) {
      const parsed = await this.readCachedJson<ExtractionResult>(`${base}/${f}`);
      if (parsed && Array.isArray(parsed.characters)) return parsed;
    }
    return null;
  }

  /** 剧本缓存期望键：与 scriptWorker 的 cacheFile 公式完全一致（标题哈希＋正文指纹＋文风） */
  private expectedScriptRest(chapter: { title: string; text: string }, styleFrag: string): string {
    return scriptCacheRest(chapter.title, chapter.text, styleFrag);
  }

  private scriptStyleFrag(): string {
    const style = (this.options.scriptStyle ?? "").trim();
    return style ? `_st${titleHash(style)}` : "";
  }

  /**
   * 剧本缓存文件分类：
   * valid（与当前章节标题＋正文＋文风匹配，可用）/
   * legacy（旧版无正文指纹，无法判定新旧，兼容保留并提示重跑）/
   * stale（新格式但指纹失配＝重分章/改标题正文/换文风后残留，必须忽略并可清理）/
   * ignore（非剧本缓存文件）
   */
  private classifyScriptCache(
    name: string,
    expectedByIndex: Map<number, string>,
  ): { kind: "valid" | "legacy" | "stale" | "ignore"; chapterPos: number } {
    const m = name.match(/^script(_demo)?_ch(\d+)_(.+)\.json$/);
    if (!m) return { kind: "ignore", chapterPos: -1 };
    const n = parseInt(m[2], 10) - 1;
    const rest = m[3];
    const expected = expectedByIndex.get(n);
    if (expected !== undefined && rest === expected) return { kind: "valid", chapterPos: n };
    if (rest.includes("_t")) return { kind: "stale", chapterPos: n };
    return { kind: "legacy", chapterPos: n };
  }

  private async loadChaptersFiltered(
    working: { index: number; title: string; text: string }[],
    styleFrag: string,
  ): Promise<{ chapters: ChapterScript[]; rawCount: number; staleCount: number; legacyCount: number }> {
    const expectedByIndex = new Map(working.map((c) => [c.index, this.expectedScriptRest(c, styleFrag)] as [number, string]));
    const chapters: ChapterScript[] = [];
    let rawCount = 0;
    let staleCount = 0;
    let legacyCount = 0;
    try {
      const entries = await tauri.listDir(this.cacheRoot);
      const files = entries
        .filter((e) => !e.isDir && /^script(_demo)?_ch\d+_/.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      // 同一 chapter 多文件：valid 优先，其次 legacy（字典序最新）；stale 直接忽略
      const picked = new Map<number, { path: string; legacy: boolean }>();
      for (const f of files) {
        rawCount++;
        const { kind, chapterPos } = this.classifyScriptCache(f.name, expectedByIndex);
        if (kind === "ignore" || kind === "stale") {
          if (kind === "stale") staleCount++;
          continue;
        }
        if (kind === "legacy") legacyCount++;
        const prev = picked.get(chapterPos);
        if (!prev) {
          picked.set(chapterPos, { path: f.path, legacy: kind === "legacy" });
        } else if (kind === "valid") {
          // valid 永远覆盖 legacy
          picked.set(chapterPos, { path: f.path, legacy: false });
        } else if (prev.legacy) {
          // legacy 之间取字典序最新（files 已排序，后者覆盖前者）
          picked.set(chapterPos, { path: f.path, legacy: true });
        }
        // 已有 valid 时后来的 legacy 直接丢弃
      }
      const ordered = [...picked.entries()].sort((a, b) => a[0] - b[0]);
      for (const [, { path }] of ordered) {
        try {
          const { text } = await tauri.readTextFile(path);
          const sc = parseChapterScript(JSON.parse(text));
          chapters[sc.chapter] = sc;
        } catch (e) {
          // 单个缓存损坏不再静默：打日志方便定位是哪一章坏了
          const { log } = await import("../utils/logger");
          log.warn("pipeline", `剧本缓存损坏已跳过：${path}`, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { chapters: chapters.filter(Boolean), rawCount, staleCount, legacyCount };
    } catch {
      return { chapters: [], rawCount, staleCount, legacyCount };
    }
  }

  /** 清理过期剧本缓存（重分章/重翻译/改标题正文/换文风后残留的失配文件），返回删除数；旧版无指纹文件保留 */
  private async pruneStaleScriptCache(
    working: { index: number; title: string; text: string }[],
    styleFrag: string,
  ): Promise<number> {
    const expectedByIndex = new Map(working.map((c) => [c.index, this.expectedScriptRest(c, styleFrag)] as [number, string]));
    let deleted = 0;
    try {
      const entries = await tauri.listDir(this.cacheRoot);
      for (const e of entries) {
        if (e.isDir || !/^script(_demo)?_ch\d+_/.test(e.name)) continue;
        if (this.classifyScriptCache(e.name, expectedByIndex).kind === "stale") {
          await tauri.removePath(e.path).catch(() => {});
          deleted++;
        }
      }
    } catch {
      /* 目录不存在 */
    }
    return deleted;
  }

  private async loadAssetMap(): Promise<AssetMap | null> {
    const file = `${this.input.outputDir}/.novel2vn/assets.json`;
    return await tauri.pathExists(file) ? readAssetMap(this.input.outputDir) : null;
  }

  private async loadMeta(): Promise<ProjectMeta | null> {
    return this.readCachedJson<ProjectMeta>(`${this.input.outputDir}/.novel2vn/meta.json`);
  }

  private async persistAssets(assets: RenderAssets): Promise<void> {
    await updateAssetMap(this.input.outputDir, (existing) => {
      Object.assign(existing.bg, assets.bg);
      Object.assign(existing.cg, assets.cg);
      Object.assign(existing.figure, assets.figure);
      Object.assign(existing.item, assets.item);
      Object.assign(existing.vocal, assets.vocal);
    });
  }

    /** 卡片变化后使依赖卡片的缓存失效（分级）：
   * 有新旧卡片时只清「被删除/外貌变化」的角色与物品对应图片文件，剧本缓存保留
   * （与卡片编辑页 saveEditedCards 同策略，避免改一句小传就全书重跑）；
   * 无旧卡片（首跑/缓存丢失）时沿用旧的全量清理。返回清理数。 */
  private async invalidateAfterCardsChange(oldCards?: ExtractionResult, newCards?: ExtractionResult): Promise<{ script: number; images: number }> {
    if (oldCards && newCards) {
      const oldChars = new Map(oldCards.characters.map((c) => [c.id, c]));
      const newChars = new Map(newCards.characters.map((c) => [c.id, c]));
      const deadCharIds = new Set<string>();
      for (const [id, oc] of oldChars) {
        const nc = newChars.get(id);
        if (!nc) {
          deadCharIds.add(id);
          continue;
        }
        if (oc.imagePrompt !== nc.imagePrompt || oc.threeViewPrompt !== nc.threeViewPrompt
          || JSON.stringify(oc.actions ?? []) !== JSON.stringify(nc.actions ?? [])
          || JSON.stringify((oc as { costumes?: unknown }).costumes ?? []) !== JSON.stringify((nc as { costumes?: unknown }).costumes ?? [])
          || JSON.stringify((oc as { emotions?: unknown }).emotions ?? []) !== JSON.stringify((nc as { emotions?: unknown }).emotions ?? [])) {
          deadCharIds.add(id);
        }
      }
      const oldItems = new Map(oldCards.items.map((i) => [i.id, i]));
      const newItems = new Map(newCards.items.map((i) => [i.id, i]));
      const deadItemIds = new Set<string>();
      for (const [id, oi] of oldItems) {
        const ni = newItems.get(id);
        if (!ni || oi.imagePrompt !== ni.imagePrompt) deadItemIds.add(id);
      }
      let images = 0;
      if (deadCharIds.size > 0 || deadItemIds.size > 0) {
        // 现存 id 的文件归属集合：删文件时必须排除仍被其它存活 id 前缀命中的文件
        //（如 id "a" 与 "a_b" 的 figure 文件都会命中前缀 figure_a_，后者不能误删；
        // 注意存活集合要剔除本次已判死刑的 id，否则改了外貌的角色旧图永远删不掉）
        const liveIds = [...newChars.keys()].filter((id) => !deadCharIds.has(id));
        const liveItemIds = [...newItems.keys()].filter((id) => !deadItemIds.has(id));
        const liveFigurePrefix = liveIds.map((id) => `figure_${sanitizeId(id).toLowerCase()}_`);
        const liveThreeview = new Set(liveIds.map((id) => `threeview_${sanitizeId(id).toLowerCase()}`));
        const liveItem = new Set(liveItemIds.map((id) => `item_${sanitizeId(id).toLowerCase()}`));
        const deadFigurePrefix = [...deadCharIds].map((id) => `figure_${sanitizeId(id).toLowerCase()}_`);
        const deadThreeview = new Set([...deadCharIds].map((id) => `threeview_${sanitizeId(id).toLowerCase()}`));
        const deadItem = new Set([...deadItemIds].map((id) => `item_${sanitizeId(id).toLowerCase()}`));
        const baseNoExt = (name: string): string => name.replace(/\.(png|jpg|jpeg|webp)$/i, "");
        try {
          const imgDir = `${this.cacheRoot}/images`;
          const entries = await tauri.listDir(imgDir);
          for (const e of entries) {
            if (e.isDir) continue;
            const lower = e.name.toLowerCase();
            const base = baseNoExt(lower);
            let dead = false;
            if (lower.startsWith("figure_")) {
              const hitDead = deadFigurePrefix.some((pre) => lower.startsWith(pre));
              const hitLive = liveFigurePrefix.some((pre) => lower.startsWith(pre));
              dead = hitDead && !hitLive;
            } else if (lower.startsWith("threeview_")) {
              dead = deadThreeview.has(base) && !liveThreeview.has(base);
            } else if (lower.startsWith("item_")) {
              dead = deadItem.has(base) && !liveItem.has(base);
            }
            if (dead) {
              await tauri.removePath(e.path).catch(() => {});
              images++;
            }
          }
        } catch {
          /* images 目录不存在 */
        }
      }
      return { script: 0, images };
    }
    let script = 0;
    let images = 0;
    try {
      const entries = await tauri.listDir(this.cacheRoot);
      for (const e of entries) {
        if (!e.isDir && /^script(_demo)?_ch\d+_/.test(e.name)) {
          await tauri.removePath(e.path).catch(() => {});
          script++;
        }
      }
    } catch {
      /* 目录不存在 */
    }
    try {
      const imgDir = `${this.cacheRoot}/images`;
      const entries = await tauri.listDir(imgDir);
      for (const e of entries) {
        if (!e.isDir && /^(figure_|item_|threeview_)/.test(e.name)) {
          await tauri.removePath(e.path).catch(() => {});
          images++;
        }
      }
    } catch {
      /* images 目录不存在 */
    }
    return { script, images };
  }

  private applyVideoOptions(script: ChapterScript): void {
    if (this.options.useVideoPoints) {
      const videoLimit = this.options.videoPointsPerChapter ?? 2;
      for (const scene of script.scenes) {
        if (scene.videoPoints && scene.videoPoints.length > videoLimit) {
          scene.videoPoints = scene.videoPoints.slice(0, videoLimit);
        }
      }
    } else {
      for (const scene of script.scenes) {
        scene.videoPoints = [];
      }
    }
  }

  /* ---------- 分章：把未切章的全文交给 AI 分章（缓存于 .novel2vn/split.json） ---------- */

  private splitCacheFile(): string {
    return `${this.input.outputDir}/.novel2vn/split.json`;
  }

    private async loadSplitChapters(): Promise<{ chapters: ChapterInfo[]; method: SplitMethod | "legacy"; discarded: number } | null> {    const parsed = await this.readCachedJson<{ fp: string; chapters: ChapterInfo[]; method?: SplitMethod; discarded?: number }>(this.splitCacheFile());
    if (!parsed || !Array.isArray(parsed.chapters) || !parsed.chapters.length) return null;
    const currentFp = novelFingerprint(this.input.novel.fullText);
    if (parsed.fp !== currentFp) {
      logger.warn("pipeline", "分章缓存与当前小说内容不一致，已忽略", {
        cached: parsed.fp.slice(0, 12),
        current: currentFp.slice(0, 12),
      });
      return null;
    }
    return { chapters: parsed.chapters, method: parsed.method ?? "legacy", discarded: parsed.discarded ?? 0 };
  }

  /** 轻量读取分章来源（不过滤指纹，用于 UI 徽标展示；stale 表示小说内容已变、分章已过期） */
  async readSplitMeta(): Promise<{ method: SplitMethod | "legacy" | "import"; at?: string; discarded: number; stale: boolean } | null> {
    const parsed = await this.readCachedJson<{ fp: string; chapters: unknown[]; method?: SplitMethod; at?: string; discarded?: number }>(this.splitCacheFile());
    if (!parsed || !Array.isArray(parsed.chapters)) return null;
    return {
      method: parsed.method ?? "legacy",
      at: parsed.at,
      discarded: parsed.discarded ?? 0,
      stale: parsed.fp !== novelFingerprint(this.input.novel.fullText),
    };
  }

  private async runSplit(): Promise<ChapterInfo[]> {
    const fullText = this.input.novel.fullText;
    const fp = novelFingerprint(fullText);
    const force = this.input.forceStages?.includes("split") || this.feedback.split;
    const skipCache = this.options.skipCache;
    const hasLlm = !!this.input.llm?.apiKey;
    if (!force && !skipCache) {
      const cached = await this.loadSplitChapters();
      if (cached) {
        // 规则回退产物不再自动升级 AI 重切（曾无感知触发下游全作废）：
        // 直接复用旧分章并明示升级路径；用户在分章意见框填意见后点「AI 分章预览」即强制 AI 重切。
        if (cached.method === "fallback" && hasLlm) {
          this.input.log({
            step: "分章",
            message: "当前为旧规则回退分章（机械切分）且已配置文本 API：为保护下游缓存，本次仍复用旧分章。如需升级 AI 分章，在分章意见框填意见后点「AI 分章预览」（将强制重切，下游剧本/图像缓存作废重跑）",
            level: "warn",
            at: Date.now(),
          });
        }
        this.lastSplitMethod = cached.method;
        this.lastSplitDiscarded = cached.discarded;
        this.input.log({
          step: "分章",
          message: `[缓存] 复用已分章结果（${cached.chapters.length} 章，来源：${cached.method === "ai" ? "AI 分章" : cached.method === "fallback" ? "规则回退" : "旧版缓存"}）`,
          level: "info",
          at: Date.now(),
        });
        return cached.chapters;
      }
    }
    if (!hasLlm) {
      this.input.log({
        step: "分章",
        message: "未配置文本 LLM API，分章降级为规则回退（按标题正则机械切分：不断超长章、不丢弃后记/插图、不合并碎章）。如需 AI 分章请先在「API 配置」页配置文本 API",
        level: "warn",
        at: Date.now(),
      });
    } else {
      this.input.log({
        step: "分章",
        message: "开始 AI 分章（识别章节标题、丢弃杂项、拆超长章、合并碎章）…",
        level: "info",
        at: Date.now(),
      });
    }
    const feedback = this.feedback.split;
    const out: { method?: SplitMethod; stats?: SplitStats } = {};
    const chapters = await withTextRetry(
      () => splitNovelForPipeline(this.input.llm!, fullText, this.onUsageCb, feedback, concurrencyFor(this.input.llm, "llm"), out),
      {
        isAborted: () => this.aborted,
        onRetry: (attempt, delay, e) =>
          this.input.log({
            step: "分章",
            message: `AI 分章失败，${delay / 1000}s 后重试（第 ${attempt} 次）：${errMsg(e).slice(0, 100)}`,
            level: "warn",
            at: Date.now(),
          }),
      },
    );
    const method = out.method ?? "fallback";
    const discarded = out.stats?.discarded ?? 0;
    this.lastSplitMethod = method;
    this.lastSplitDiscarded = discarded;
    await tauri.mkdirAll(this.cacheRoot);
    await tauri.writeTextFile(this.splitCacheFile(), JSON.stringify({ fp, chapters, method, at: new Date().toISOString(), discarded }, null, 2));
    this.input.log({
      step: "分章",
      message: method === "ai"
        ? `AI 分章完成：共 ${chapters.length} 章${discarded > 0 ? `（已丢弃 ${discarded} 个杂项块）` : ""}${(out.stats?.mergedTiny ?? 0) > 0 ? `（碎章合并 ${out.stats!.mergedTiny} 个）` : ""}`
        : `规则回退分章完成：共 ${chapters.length} 章（机械切分，未做杂项丢弃/超长拆分/碎章合并）`,
      level: "success",
      at: Date.now(),
    });
    return chapters;
  }

  /* ---------- 纯追加分章：旧章原样保留，只对新增文本分章 ---------- */

  private async runAppendSplit(baseFullText: string, tailRaw: string): Promise<ChapterInfo[]> {
    const tail = tailRaw.replace(/\r/g, "").replace(/^\s+/, "").replace(/\s+$/, "");
    if (!tail) throw new Error("追加内容为空，已中止");
    const parsed = await this.readCachedJson<{ fp: string; chapters: ChapterInfo[]; method?: SplitMethod; discarded?: number }>(
      this.splitCacheFile(),
    );
    if (!parsed || !Array.isArray(parsed.chapters) || !parsed.chapters.length) {
      throw new Error("项目还没有已分章结果，无法追加：请先正常生成一次（至少跑完分章），再追加新章节");
    }
    if (parsed.fp !== novelFingerprint(baseFullText)) {
      throw new Error("原文与分章缓存对不上（可能更换过小说或重分过章），追加已中止：请走全量流程，或确认原文无误后重试");
    }
    const oldChapters = parsed.chapters.map((c, i) => ({ ...c, index: i }));
    const newFull = joinAppendText(baseFullText, tail);
    const newFp = novelFingerprint(newFull);
    // 只对新增部分分章（与 runSplit 同重试/并发模型；无 LLM 时规则回退）
    const out: { method?: SplitMethod; stats?: SplitStats } = {};
    const hasLlm = !!this.input.llm?.apiKey;
    if (hasLlm) {
      this.input.log({
        step: "分章",
        message: `增量追加：旧 ${oldChapters.length} 章原样保留，只对新增约 ${tail.length} 字分章…`,
        level: "info",
        at: Date.now(),
      });
    }
    const tailChapters = await withTextRetry(
      () => splitNovelForPipeline(this.input.llm!, tail, this.onUsageCb, this.feedback.split, concurrencyFor(this.input.llm, "llm"), out),
      {
        isAborted: () => this.aborted,
        onRetry: (attempt, delay, e) =>
          this.input.log({
            step: "分章",
            message: `增量分章失败，${delay / 1000}s 后重试（第 ${attempt} 次）：${errMsg(e).slice(0, 100)}`,
            level: "warn",
            at: Date.now(),
          }),
      },
    );
    if (!tailChapters.length) throw new Error("新增部分分章结果为空，已中止（旧章节未动）");
    tailChapters.forEach((c, i) => {
      c.index = oldChapters.length + i;
    });
    const method = out.method ?? "fallback";
    const discarded = out.stats?.discarded ?? 0;
    this.lastSplitMethod = method;
    this.lastSplitDiscarded = discarded;
    this.appendedIndexes = tailChapters.map((c) => c.index);
    const working = [...oldChapters, ...tailChapters];
    await tauri.mkdirAll(this.cacheRoot);
    await tauri.writeTextFile(this.splitCacheFile(), JSON.stringify({ fp: newFp, chapters: working, method, at: new Date().toISOString(), discarded }, null, 2));
    this.input.log({
      step: "分章",
      message: `增量分章完成：保留旧 ${oldChapters.length} 章，新增 ${tailChapters.length} 章（第 ${oldChapters.length + 1}～${working.length} 章），共 ${working.length} 章`,
      level: "success",
      at: Date.now(),
    });
    return working;
  }

  /* ---------- 翻译：把小说章节翻译为目标语言（缓存于 .novel2vn/translate/，不被提取指纹清理） ---------- */

  // 翻译缓存键只用语言＋标题＋正文哈希（不含章节序号）：旧键含 ch 序号，
  // 重分章编号一变就全重翻。相同标题正文的章节共用一份译文，无影响。
  private translateCacheFile(lang: string, ch: { index: number; title: string; text: string }): string {
    return `${this.input.outputDir}/.novel2vn/translate/translate_${lang}_${titleHash(ch.title)}_${titleHash(ch.text)}.json`;
  }

  /** 一次性清理旧版带序号的翻译缓存（translate_<lang>_ch<序号>_…），新键命中不再需要它们 */
  private async purgeLegacyTranslateCache(lang: string): Promise<number> {
    let deleted = 0;
    try {
      const dir = `${this.input.outputDir}/.novel2vn/translate`;
      const entries = await tauri.listDir(dir);
      const langEsc = lang.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const e of entries) {
        if (!e.isDir && new RegExp(`^translate_${langEsc}_ch\\d+_`).test(e.name)) {
          await tauri.removePath(e.path).catch(() => {});
          deleted++;
        }
      }
    } catch {
      /* 目录不存在 */
    }
    return deleted;
  }

  private async runTranslation(chapters: ChapterInfo[], lang: string): Promise<ChapterInfo[]> {
    const cfg = this.input.llm!;
    const dir = `${this.input.outputDir}/.novel2vn/translate`;
    await tauri.mkdirAll(dir);
    const force = this.input.forceStages?.includes("translate") || !!this.feedback.translate;
    const feedback = this.feedback.translate;
    const out: ChapterInfo[] = [];
    const total = chapters.length;
    let done = 0;
    const emitProgress = (title: string): void => {
      done++;
      this.input.log({
        step: "翻译",
        message: `进度 ${done}/${total}：${title}`,
        level: "info",
        at: Date.now(),
        progress: { done, total, label: title },
      });
    };
    const results: (ChapterInfo | null)[] = new Array(total);
    // 逐章翻译并发生成（并发数来自文本 API 配置；缓存命中直接复用，失败保留原文继续）
    const concurrency = concurrencyFor(this.input.llm, "llm");
    // 旧版带序号翻译缓存一次性清理（键已改为去序号，新文件会重新生成）
    void this.purgeLegacyTranslateCache(lang).then((n) => {
      if (n > 0) {
        this.input.log({ step: "翻译", message: `已清理 ${n} 个旧版翻译缓存（序号键已废除，命中新键后自动重建）`, level: "info", at: Date.now() });
      }
    });
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < chapters.length) {
        const pos = idx++;
        const ch = chapters[pos];
        this.checkAbort();
        const cacheFile = this.translateCacheFile(lang, ch);
        let cached: { title: string; text: string } | null = null;
        if (!force) {
          cached = await this.readCachedJson<{ title: string; text: string }>(cacheFile);
        }
        if (cached) {
          this.input.log({
            step: "翻译",
            message: `[缓存] 第 ${ch.index + 1} 章译文：${cached.title}`,
            level: "info",
            at: Date.now(),
          });
          emitProgress(cached.title);
          results[pos] = { ...ch, title: cached.title, text: cached.text };
          continue;
        }
        this.input.log({
          step: "翻译",
          message: `翻译第 ${ch.index + 1} 章：${ch.title}`,
          level: "info",
          at: Date.now(),
        });
        try {
          const tr = await withTextRetry(
            () => translateChapter(cfg, ch, lang, this.onUsageCb, feedback),
            {
              isAborted: () => this.aborted,
              onRetry: (attempt, delay, e) =>
                this.input.log({
                  step: "翻译",
                  message: `第 ${ch.index + 1} 章翻译失败，${delay / 1000}s 后重试（第 ${attempt} 次）：${errMsg(e).slice(0, 100)}`,
                  level: "warn",
                  at: Date.now(),
                }),
            },
          );
          await tauri.writeTextFile(cacheFile, JSON.stringify(tr, null, 2));
          emitProgress(tr.title);
          results[pos] = { ...ch, title: tr.title, text: tr.text };
        } catch (e) {
          this.recordFailure({
            id: `translate_${ch.index + 1}`,
            kind: "llm",
            step: "翻译",
            message: `第 ${ch.index + 1} 章：${errMsg(e)}`,
            at: Date.now(),
          });
          this.input.log({
            step: "翻译",
            message: `第 ${ch.index + 1} 章翻译失败，已保留原文继续（可在「失败项」定位重试）：${errMsg(e).slice(0, 100)}`,
            level: "warn",
            at: Date.now(),
            taskId: `translate_${ch.index + 1}`,
            taskKind: "llm",
          });
          results[pos] = ch;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
    for (const item of results) if (item) out.push(item);
    this.input.log({
      step: "翻译",
      message: `翻译完成：${out.length} 章 → ${languageName(lang)}`,
      level: "success",
      at: Date.now(),
    });
    return out;
  }

  private async loadTranslation(chapters: ChapterInfo[], lang: string): Promise<ChapterInfo[] | null> {
    const out: ChapterInfo[] = [];
    let any = false;
    for (const ch of chapters) {
      const cached = await this.readCachedJson<{ title: string; text: string }>(this.translateCacheFile(lang, ch));
      if (cached) {
        out.push({ ...ch, title: cached.title, text: cached.text });
        any = true;
      } else {
        out.push(ch);
      }
    }
    return any ? out : null;
  }

  async run(): Promise<PipelineResult> {
    const { input } = this;
    this.cacheRoot = `${input.outputDir}/.novel2vn/cache`;
    const runStart = logger.time("pipeline", "管线整体运行");
    // 文本/视觉请求限流跟随各 API 自己的并发配置（各 API 互不影响）
    if (input.llm) setLlmConcurrency(input.llm, concurrencyFor(input.llm, "llm"));
    if (input.vision) setLlmConcurrency(input.vision, concurrencyFor(input.vision, "vision"));
    const stages = new Set<StageKey>(input.stages ?? (STAGE_ORDER as StageKey[]));
    if (stages.has("image") && input.options.useImage) assertVisualBibleApprovalStatus(input.visualBible);
    logger.info("pipeline", "开始运行", {
      demo: !input.llm?.apiKey,
      outputDir: input.outputDir,
      chapterCount: input.novel.chapters.length,
      stages: Array.from(stages),
      forceStages: input.forceStages,
      hasFeedback: Object.keys(this.feedback).length > 0,
      options: {
        useImage: input.options.useImage,
        useTts: input.options.useTts,
        useBgm: input.options.useBgm,
        figureEmotions: input.options.figureEmotions,
        skipCache: input.options.skipCache,
        scriptStyle: input.options.scriptStyle,
        rerunChapters: input.options.rerunChapters,
      },
    });
    await tauri.mkdirAll(this.cacheRoot);
    const cacheDir = cacheDirFor(this.cacheRoot, "");

    const log = input.log;
    const onUsage = (pt: number, ct: number) => {
      this.cost.llmTokens += pt + ct;
      this.cost.llmCostYuan += (pt / 1e6) * DEFAULT_PRICES.llmInYuanPer1m + (ct / 1e6) * DEFAULT_PRICES.llmOutYuanPer1m;
    };
    this.onUsageCb = onUsage;

    const demo = !input.llm?.apiKey;
    if (demo && stages.has("extract")) {
      log({
        step: "提取",
        message: "未配置文本 LLM API，使用演示模式（内置示例小说的角色/场景/物品卡）",
        level: "warn",
        at: Date.now(),
      });
    }

    /* ==================== ① 分章（可选，把未切章的全文交给 AI 分章） ==================== */
    let workingChapters = input.novel.chapters;
    if (stages.has("split")) {
      const appendTail = input.append?.tailText?.trim() ? input.append.tailText : "";
      workingChapters = appendTail && input.append
        ? await this.runAppendSplit(input.append.baseFullText, appendTail)
        : await this.runSplit();
      log({
        step: "分章",
        message: `分章完成：共 ${workingChapters.length} 章`,
        level: "success",
        at: Date.now(),
      });
    } else if (input.append?.tailText?.trim()) {
      throw new Error("增量追加必须勾选「分章」阶段（新增部分需要分章），已中止（旧章节未动）");
    } else if (!input.novel.chapters.length || (input.novel.chapters.length === 1 && input.novel.chapters[0].text === input.novel.fullText)) {
      // 未勾选分章，且导入时是未切章状态（单章=全文）→ 需要从缓存恢复 AI 分章结果
      const cachedSplit = await this.loadSplitChapters();
      if (cachedSplit) {
        workingChapters = cachedSplit.chapters;
        this.lastSplitMethod = cachedSplit.method;
        this.lastSplitDiscarded = cachedSplit.discarded;
        log({ step: "分章", message: `[缓存] 复用已分章结果（${cachedSplit.chapters.length} 章）`, level: "info", at: Date.now() });
      }
    } else if (this.lastSplitMethod === undefined) {
      // 导入时已切章：用缓存元数据恢复真实来源（AI/回退/旧版）；无缓存即导入规则切分
      try {
        const meta = await this.readSplitMeta();
        if (meta) {
          this.lastSplitMethod = meta.method;
          this.lastSplitDiscarded = meta.discarded;
        } else {
          this.lastSplitMethod = "import";
        }
      } catch {
        this.lastSplitMethod = "import";
      }
    }

    /* ==================== ② 翻译（可选，先翻译再提取） ==================== */
    const lang = (this.options.language ?? "").trim();
    const canTranslate = !!input.llm && !!lang;
    if (stages.has("translate")) {
      if (canTranslate) {
        log({ step: "翻译", message: `开始把小说翻译为「${languageName(lang)}」…`, level: "info", at: Date.now() });
        workingChapters = await this.runTranslation(workingChapters, lang);
      } else if (lang) {
        log({ step: "翻译", message: "已设置目标语言但未配置文本 LLM，无法翻译，将使用原文生成", level: "warn", at: Date.now() });
      } else {
        log({ step: "翻译", message: "未设置目标语言，使用原文生成", level: "info", at: Date.now() });
      }
    } else if (canTranslate) {
      const restored = await this.loadTranslation(workingChapters, lang);
      if (restored) {
        workingChapters = restored;
        log({ step: "翻译", message: `[缓存] 复用已翻译章节（${languageName(lang)}）`, level: "info", at: Date.now() });
      } else {
        log({ step: "翻译", message: "未勾选翻译阶段且无已翻译缓存，将使用原文", level: "warn", at: Date.now() });
      }
    }
    const workingNovel: NovelDoc = {
      ...input.novel,
      fullText: workingChapters.map((c) => c.text).join("\n\n"),
      chapters: workingChapters,
    };
    this.checkAbort();

    /* ==================== ② 提取 ==================== */
    let cards: ExtractionResult | undefined = input.cards;
    if (stages.has("extract")) {
      log({ step: "提取", message: "开始提取角色/场景/物品卡…", level: "info", at: Date.now() });
      const cachePrefix = demo ? "cards_demo" : "cards";
      const cardsCache = `${input.outputDir}/.novel2vn/${cachePrefix}.json`;
      const extractFeedback = this.feedback.extract;
      const forceExtract = input.forceStages?.includes("extract");
      // 小说指纹：源文件路径 + 各章正文拼接哈希（分隔符不敏感；不含章节标题；
      // 重分章只改切分点时指纹不变，不会误删图片/配音缓存）
      const novelFp = `${input.novel.sourcePath}:${novelBodyFingerprint(workingChapters.map((c) => c.text))}`;
      const appendTail = input.append?.tailText?.trim() ? input.append.tailText : "";
      if (appendTail) {
        // 纯追加提取：老卡片为底，只对新增文本提取后合并；老剧本/老图一个不动，不做任何失效清理
        const oldCards = (await this.readCachedJson<ExtractionResult>(cardsCache)) ?? undefined;
        if (!oldCards) throw new Error("项目还没有卡片缓存，无法追加：请先全量生成一次，再追加新章节");
        log({ step: "提取", message: `增量追加：保留旧卡片（${oldCards.characters.length} 角色），只对新增约 ${appendTail.trim().length} 字提取…`, level: "info", at: Date.now() });
        const tailText = appendTail.replace(/\r/g, "").trim();
        const title = workingNovel.fileName.replace(/\.txt$/i, "");
        try {
          const useAgent = !!this.options.extractAgent;
          const runTailExtract = (): Promise<ExtractionResult> =>
            useAgent
              ? extractFromNovelAgent(input.llm!, tailText, title, {
                  onUsage,
                  isAborted: () => this.aborted,
                  log: (message, level = "info") => log({ step: "提取", message, level, at: Date.now() }),
                })
              : extractFromNovel(input.llm!, tailText, title, onUsage);
          const fresh = demo
            ? demoExtract(tailText, title)
            : await withTextRetry(runTailExtract, {
                isAborted: () => this.aborted,
                onRetry: (attempt, delay, e) =>
                  log({
                    step: "提取",
                    message: `增量提取失败，${delay / 1000}s 后重试（第 ${attempt} 次）：${errMsg(e).slice(0, 100)}`,
                    level: "warn",
                    at: Date.now(),
                  }),
              });
          const { merged, addedCharacters, addedScenes, addedItems } = mergeAppendedCards(oldCards, fresh);
          cards = merged;
          await tauri.writeTextFile(cardsCache, JSON.stringify({ ...cards, _novelFp: novelFp }, null, 2));
          log({
            step: "提取",
            message: `增量提取完成：新增角色 ${addedCharacters.length}${addedCharacters.length ? `（${addedCharacters.slice(0, 5).join("、")}${addedCharacters.length > 5 ? "…" : ""}）` : ""}、场景 ${addedScenes}、物品 ${addedItems}；旧卡片与全部旧素材保留`,
            level: "success",
            at: Date.now(),
          });
        } catch (e) {
          this.recordFailure({ id: "extract-append", kind: "llm", step: "提取", message: errMsg(e), at: Date.now() });
          throw e;
        }
      } else if (!cards && !this.options.skipCache && !extractFeedback && !forceExtract) {
        cards = (await this.readCachedJson<ExtractionResult>(cardsCache)) ?? undefined;
        if (cards && (cards as { _novelFp?: string })._novelFp !== novelFp) {
          // 分级失效（不再删除整个 cacheRoot）：
          // 旧实现此处删掉图片/配音/剧本全部文件，重分章等场景下造成全书重生成。
          // 现在仅作废卡片、走重提；重提后由 invalidateAfterCardsChange 只清剧本缓存+人物/物品图，
          // 背景/CG/配音文件保留，残留映射由管线剪枝与一键清理收尾。
          log({
            step: "提取",
            message: "检测到小说内容变化（或更换了小说），旧卡片缓存已作废，正在重新提取（背景/CG/配音文件予以保留，过期映射稍后自动剪枝）…",
            level: "warn",
            at: Date.now(),
          });
          cards = undefined;
        }
      }
      if (!cards) {
        try {
          const useAgent = !!this.options.extractAgent;
          const runExtract = (): Promise<ExtractionResult> =>
            useAgent
              ? extractFromNovelAgent(input.llm!, workingNovel.fullText, workingNovel.fileName.replace(/\.txt$/i, ""), {
                  onUsage,
                  isAborted: () => this.aborted,
                  feedback: extractFeedback,
                  log: (message, level = "info") => log({ step: "提取", message, level, at: Date.now() }),
                })
              : extractFromNovel(input.llm!, workingNovel.fullText, workingNovel.fileName.replace(/\.txt$/i, ""), onUsage, extractFeedback);
          cards = demo
            ? demoExtract(workingNovel.fullText, workingNovel.fileName.replace(/\.txt$/i, ""))
            : await withTextRetry(runExtract, {
                isAborted: () => this.aborted,
                onRetry: (attempt, delay, e) =>
                  log({
                    step: "提取",
                    message: `提取失败，${delay / 1000}s 后重试（第 ${attempt} 次）：${errMsg(e).slice(0, 100)}`,
                    level: "warn",
                    at: Date.now(),
                  }),
              });
        } catch (e) {
          this.recordFailure({
            id: "extract",
            kind: "llm",
            step: "提取",
            message: errMsg(e),
            at: Date.now(),
          });
          throw e;
        }
        const prevCards = (await this.readCachedJson<ExtractionResult>(cardsCache)) ?? undefined;
        await tauri.writeTextFile(cardsCache, JSON.stringify({ ...cards, _novelFp: novelFp }, null, 2));
        // 新提取（指纹失配/意见/强制/首跑）后分级失效下游：有新旧卡片时只清被删/外貌变化者的图，
        // 剧本缓存保留（与卡片编辑页同策略）；无旧卡片时沿用全量清理。首跑时目录为空，调用无害。
        {
          const cleared = await this.invalidateAfterCardsChange(prevCards, cards);
          if (cleared.script > 0 || cleared.images > 0) {
            this.log(`重新提取完成，已使 ${cleared.script} 个剧本缓存 / ${cleared.images} 个立绘物品图缓存失效，后续阶段将使用新卡片`, "success", "提取");
          }
        }
        log({
          step: "提取",
          message: `提取完成：${cards.characters.length} 角色 / ${cards.scenes.length} 场景 / ${cards.items.length} 物品`,
          level: "success",
          at: Date.now(),
        });
      } else {
        log({ step: "提取", message: "[缓存] 复用角色/场景/物品卡", level: "info", at: Date.now() });
      }
      logger.info("pipeline", "提取阶段完成", {
        fromCache: !!cards && (cards as { _novelFp?: string })._novelFp !== undefined,
        characters: cards!.characters.length,
        scenes: cards!.scenes.length,
        items: cards!.items.length,
      });
    } else {
      cards = cards ?? (await this.loadCards()) ?? undefined;
      if (cards) {
        log({ step: "提取", message: "[缓存] 复用角色/场景/物品卡", level: "info", at: Date.now() });
      } else {
        throw new Error("未勾选「提取」阶段且无卡片缓存，请先勾选提取或加载已有项目");
      }
    }
    this.checkAbort();

    /* ==================== ③ 分章剧本 ==================== */
    const chapters: ChapterScript[] = [];
    if (stages.has("script")) {
      const activeChapters = workingChapters.filter((c) => c.enabled !== false);
      // 注意：activeChapterIndexes 在剧本收集完成后统一赋值（见下），此处不提前记录，
      // 否则缺缓存被跳过的章节会导致 novelIdx→pos 错位、分章节过滤打到错误的章
      const scriptForce = input.forceStages?.includes("script");
      // 纯追加模式：只跑新章（无视 rerunChapters，避免把旧章卷进来重写）
      const rerunSet = new Set(
        this.appendedIndexes.length
          ? [...this.appendedIndexes, ...Object.keys(this.feedback.script ?? {}).map(Number)]
          : scriptForce ? activeChapters.map((c) => c.index) : (this.options.rerunChapters ?? activeChapters.map((c) => c.index)),
      );
      if (this.appendedIndexes.length) {
        log({ step: "剧本", message: `增量追加：只生成新增的 ${this.appendedIndexes.length} 章剧本，其余 ${activeChapters.length - this.appendedIndexes.length} 章复用缓存`, level: "info", at: Date.now() });
      }
      const feedbackSet = new Set(Object.keys(this.feedback.script ?? {}).map(Number));
      const style = (this.options.scriptStyle ?? "").trim();
      const styleFrag = style ? `_st${titleHash(style)}` : "";
      // 先清理与当前章节失配的过期剧本缓存（重分章/重翻译/改标题正文/换文风后残留），
      // 避免旧剧本混入本次结果；旧版无指纹文件保留（加载时兼容并提示重跑）
      const prunedScripts = await this.pruneStaleScriptCache(workingChapters, styleFrag);
      if (prunedScripts > 0) {
        log({
          step: "剧本",
          message: `已清理 ${prunedScripts} 个过期剧本缓存（章节内容变化后残留），缺失章节将在本阶段按规则补生成`,
          level: "info",
          at: Date.now(),
        });
      }
      let scriptTotal = activeChapters.length;
      let scriptDone = 0;
      const emitScriptProgress = (title: string): void => {
        scriptDone++;
        log({
          step: "剧本",
          message: `进度 ${scriptDone}/${scriptTotal}：${title}`,
          level: "info",
          at: Date.now(),
          progress: { done: scriptDone, total: scriptTotal, label: title },
        });
      };
      // 逐章剧本并发生成：并发数来自文本 API 配置（各自独立）。
      // 文本请求体可达 2 万+ 字符，实际同时发出的请求数由该 API 的请求级限流器兜底
      // （setLlmConcurrency，见 openaiCompatible.ts），避免并发过大打爆网关。
      const scriptConcurrency = concurrencyFor(input.llm, "llm");
      const scriptResults: (ChapterScript | null)[] = new Array(activeChapters.length);
      // 部分重跑（单章/失败重试/带意见）时：未选中的章节先静默复用缓存，不占进度名额、不打逐章日志；
      // 全量运行时保持原行为（逐章日志，便于观察整体进度）
      const partialRun = feedbackSet.size > 0 || rerunSet.size < activeChapters.length;
      const pendingPos: number[] = [];
      if (partialRun) {
        let reused = 0;
        for (let pos = 0; pos < activeChapters.length; pos++) {
          const chapter = activeChapters[pos];
          if (!rerunSet.has(chapter.index) && !feedbackSet.has(chapter.index)) {
            const hit = await this.readCachedJson<ChapterScript>(
              scriptCacheFileName(cacheDir, demo, chapter.index, chapter.title, chapter.text || "", styleFrag),
            );
            if (hit) {
              scriptResults[pos] = hit;
              reused++;
              continue;
            }
            // 无缓存：留给 worker（走原 warn 跳过逻辑，组装保护会兜底）
          }
          pendingPos.push(pos);
        }
        scriptTotal = pendingPos.length;
        if (reused > 0) {
          log({
            step: "剧本",
            message: `缓存静默复用 ${reused} 章（本次只动目标章节，其余未动、0 计费）`,
            level: "info",
            at: Date.now(),
          });
        }
      } else {
        for (let pos = 0; pos < activeChapters.length; pos++) pendingPos.push(pos);
      }
      let scriptIdx = 0;
      const scriptWorker = async (): Promise<void> => {
        while (scriptIdx < pendingPos.length) {
          const pos = pendingPos[scriptIdx++];
          const chapter = activeChapters[pos];
          this.checkAbort();
          // 缓存键含标题+正文指纹：正文修改即换键，避免旧剧本残留复用；旧无指纹文件加载时兼容判断
          const cacheFile = scriptCacheFileName(cacheDir, demo, chapter.index, chapter.title, chapter.text || "", styleFrag);
          const hasFeedback = feedbackSet.has(chapter.index);
          const selected = rerunSet.has(chapter.index);
          let script: ChapterScript | null = null;
          if (!selected && !hasFeedback) {
            script = await this.readCachedJson<ChapterScript>(cacheFile);
            if (script) {
              log({ step: "剧本", message: `[缓存] 第 ${chapter.index + 1} 章（未勾选重跑，复用）：${chapter.title}`, level: "info", at: Date.now() });
            } else {
              log({
                step: "剧本",
                message: `第 ${chapter.index + 1} 章未勾选重跑且无缓存，跳过：${chapter.title}`,
                level: "warn",
                at: Date.now(),
              });
              this.skippedScriptChapters.push(`第 ${chapter.index + 1} 章 ${chapter.title}`);
              continue;
            }
          } else {
            if (!this.options.skipCache && !hasFeedback && !scriptForce) {
              script = await this.readCachedJson<ChapterScript>(cacheFile);
            }
            if (!script) {
              log({
                step: "剧本",
                message: `生成第 ${chapter.index + 1} 章剧本：${chapter.title}${hasFeedback ? "（按你的意见重写）" : ""}`,
                level: "info",
                at: Date.now(),
              });
              try {
                script = demo
                  ? demoScriptAll([chapter], cards!)[0]
                  : await withTextRetry(
                      () => scriptChapter(input.llm!, chapter, cards!, onUsage, {
                        style: style || undefined,
                        feedback: this.feedback.script?.[chapter.index],
                      }),
                      {
                        isAborted: () => this.aborted,
                        onRetry: (attempt, delay, e) =>
                          log({
                            step: "剧本",
                            message: `第 ${chapter.index + 1} 章剧本生成失败，${delay / 1000}s 后重试（第 ${attempt} 次）：${errMsg(e).slice(0, 100)}`,
                            level: "warn",
                            at: Date.now(),
                          }),
                      },
                    );
              } catch (e) {
                this.recordFailure({
                  id: `chapter_${chapter.index + 1}`,
                  kind: "script",
                  step: "剧本",
                  message: `第 ${chapter.index + 1} 章：${errMsg(e)}`,
                  at: Date.now(),
                });
                log({
                  step: "剧本",
                  message: `第 ${chapter.index + 1} 章剧本失败（已跳过，可在「失败项」定位重试；其余章节继续生成）：${errMsg(e).slice(0, 100)}`,
                  level: "error",
                  at: Date.now(),
                  taskId: `chapter_${chapter.index + 1}`,
                  taskKind: "script",
                });
                continue;
              }
              if (!script) {
                this.recordFailure({
                  id: `chapter_${chapter.index + 1}`,
                  kind: "script",
                  step: "剧本",
                  message: `第 ${chapter.index + 1} 章：剧本结果为空`,
                  at: Date.now(),
                });
                continue;
              }
              await tauri.writeTextFile(cacheFile, JSON.stringify(script, null, 2));
              // 保真自检：拿原文逐句核对刚生成的剧本（覆盖率＋说话人归属），只告警不阻断
              try {
                const vr = verifyScriptAgainstSource(chapter.text || "", script.scenes, cards!.characters);
                const pct = Math.round(vr.keptRatio * 100);
                const suspectSpeakers = vr.speakerIssues.filter((i) => i.reason !== "not-in-source").length;
                if (vr.originalQuoteCount >= 5 && (vr.keptRatio < 0.9 || vr.notFoundCount > 0 || suspectSpeakers > 0)) {
                  log({
                    step: "剧本",
                    message: `第 ${chapter.index + 1} 章保真告警：原文 ${vr.originalQuoteCount} 处引语→剧本 ${vr.dialogueCount} 句对话（${pct}%），${vr.notFoundCount} 句原文无出处，${suspectSpeakers} 处说话人存疑（短回合可能被合并/删除，详见后续 warn）`,
                    level: "warn",
                    at: Date.now(),
                  });
                  for (const iss of vr.speakerIssues.slice(0, 5)) {
                    log({ step: "剧本", message: `存疑：场景${iss.sceneIndex + 1}#${iss.lineIndex + 1}「${iss.text}」——${iss.detail}`, level: "warn", at: Date.now() });
                  }
                  if (vr.speakerIssues.length > 5) {
                    log({ step: "剧本", message: `……还有 ${vr.speakerIssues.length - 5} 处存疑未列出`, level: "warn", at: Date.now() });
                  }
                } else {
                  log({
                    step: "剧本",
                    message: `第 ${chapter.index + 1} 章保真自检通过：原文 ${vr.originalQuoteCount} 处引语→剧本 ${vr.dialogueCount} 句对话（${pct}%）`,
                    level: "info",
                    at: Date.now(),
                  });
                }
              } catch {
                /* 自检失败不阻断生成 */
              }
                } else {
              log({
                step: "剧本",
                message: `[缓存] 第 ${chapter.index + 1} 章：${chapter.title}`,
                level: "info",
                at: Date.now(),
              });
            }
          }
          this.applyVideoOptions(script);
          ensureUniqueSceneIds(script);
          scriptResults[pos] = script;
          emitScriptProgress(chapter.title);
          logger.debug("pipeline", `第 ${chapter.index + 1} 章剧本就绪`, {
            title: chapter.title,
            scenes: script.scenes.length,
            lines: script.scenes.reduce((n, s) => n + s.lines.length, 0),
          });
        }
      };
      await Promise.all(Array.from({ length: Math.min(scriptConcurrency, activeChapters.length) }, () => scriptWorker()));
      for (const script of scriptResults) if (script) chapters.push(script);
      // 章节映射（必须在重编号前记录）：此时 c.chapter 仍是 novel 原始 index，
      // 按最终 chapters 顺序记录，缺缓存被跳过的章节自然错开，供图像/配音分章节过滤精确定位
      this.activeChapterIndexes = chapters.map((c) => c.chapter);
    } else {
      // 指纹过滤：只接受与当前章节（标题＋正文＋文风）匹配的剧本缓存，
      // 重分章/重导小说/改标题正文后的残留文件会被忽略（不再按字典序误用旧剧本）
      const styleFragElse = this.scriptStyleFrag();
      const loaded = await this.loadChaptersFiltered(workingChapters, styleFragElse);
      const cachedChapters = loaded.chapters;
      if (cachedChapters.length) {
        for (const c of cachedChapters) {
          this.applyVideoOptions(c);
          ensureUniqueSceneIds(c);
          chapters.push(c);
        }
        // 章节映射（重编号前记录，缓存剧本自带的 chapter 即 novel 原始 index）：
        // 纯资产重跑（未跑 script）也能正确做图像/配音分章节过滤
        this.activeChapterIndexes = chapters.map((c) => c.chapter);
        log({ step: "剧本", message: `[缓存] 复用 ${chapters.length} 章剧本`, level: "info", at: Date.now() });
        if (loaded.staleCount > 0) {
          log({
            step: "剧本",
            message: `已忽略 ${loaded.staleCount} 个过期剧本缓存（章节内容变化后残留），下次运行剧本阶段时会自动清理`,
            level: "warn",
            at: Date.now(),
          });
        }
        if (loaded.legacyCount > 0) {
          log({
            step: "剧本",
            message: `发现 ${loaded.legacyCount} 个旧版无指纹剧本缓存（无法判定新旧，已兼容复用；建议重跑一次剧本阶段以纳入保真校验）`,
            level: "warn",
            at: Date.now(),
          });
        }
      } else if (stages.has("split") || stages.has("translate") || stages.has("extract")) {
        // 单一阶段重跑上游（分章/翻译/提取）已使下游剧本缓存失效，本次不联动下游：
        // 允许上游单阶段成功返回，下游需用户手动依次重跑（避免一次点击烧掉整套下游费用）。
        log({
          step: "剧本",
          message: "上游已更新，旧剧本缓存已失效，本次仅重跑上游，下游未联动（需手动依次重跑剧本 → 图像/配音 → 组装）",
          level: "warn",
          at: Date.now(),
        });
      } else if (loaded.rawCount > 0) {
        // 有缓存文件但全部失配：明确告诉用户原因，而不是静默用错或含糊报错
        throw new Error(
          `未找到与当前小说匹配的剧本缓存（现有 ${loaded.rawCount} 个缓存：${loaded.staleCount} 个因章节内容变化已过期` +
            `${loaded.legacyCount ? `，${loaded.legacyCount} 个为旧版无指纹缓存` : ""}）。` +
            "可能原因：重分章 / 重导小说 / 修改标题正文 / 切换翻译语言后未重跑剧本。请先运行「剧本」阶段（勾选剧本后点开始，或点该阶段的重新生成）。",
        );
      } else {
        throw new Error("未勾选「剧本」阶段且无剧本缓存，请先勾选剧本或加载已有项目");
      }
    }
    logger.info("pipeline", "剧本阶段完成", { totalChapters: chapters.length });

    // 章节重新编号（过滤未启用的章节后）→ 图像/配音/组装使用统一编号，保证素材键一致
    chapters.forEach((c, i) => {
      c.chapter = i;
    });
    // 跨章场景 id 唯一化：LLM 不同章都输出 s1/s2… 时，背景图/配音/BGM 会互相覆盖
    dedupeSceneIdsAcrossChapters(chapters);

    // 素材映射始终以磁盘已有内容为基础（合并而非覆盖）：
    // 即使本次勾选 image/voice 且中途失败/中断，也不会把之前已生成的图映射清空
    // （旧实现：未勾选 image/voice 才恢复 → 勾选 image 且部分失败时 persistAssets 用不完整
    //  内容覆盖 assets.json，导致「把前面的图弄没了」）。
    const assets: RenderAssets = { bg: {}, cg: {}, figure: {}, item: {}, vocal: {}, bgm: {} };
    const existingAssets = await this.loadAssetMap();
    if (existingAssets) {
      assets.bg = existingAssets.bg ?? {};
      assets.cg = existingAssets.cg ?? {};
      assets.figure = existingAssets.figure ?? {};
      assets.item = existingAssets.item ?? {};
      assets.vocal = existingAssets.vocal ?? {};
    }

    // 映射自动剪枝（仅当剧本覆盖完整时）：删掉当前剧本不再引用的 bg/cg/vocal 旧条目，
    // 解决「重分章后映射总数只增不减」。单章等不完整上下文（有缺缓存章节）绝不剪，
    // 由一键清理（repairImageAssets）在完整上下文里收尾。
    {
      const activeCount = workingChapters.filter((c) => c.enabled !== false).length;
      if (existingAssets && chapters.length > 0 && chapters.length >= activeCount && this.skippedScriptChapters.length === 0) {
        const stat = pruneAssetRefs(assets, chapters);
        const total = stat.bg + stat.cg + stat.vocal;
        if (total > 0 || stat.cgMigrated > 0) {
          await updateAssetMap(input.outputDir, (m) => {
            m.bg = assets.bg;
            m.cg = assets.cg;
            m.vocal = assets.vocal;
          });
          log({
            step: "组装",
            message: `素材映射已剪枝：清理过期引用 ${total} 项（背景 ${stat.bg}、CG ${stat.cg}、配音 ${stat.vocal}）${stat.cgMigrated > 0 ? `，迁移旧版 CG 键 ${stat.cgMigrated} 项` : ""}；孤儿文件可用素材页「清理无效素材」删除`,
            level: "info",
            at: Date.now(),
          });
        }
      }
    }

    /* ==================== ④ 图像 ==================== */
    if (stages.has("image")) {
      if (this.options.useImage) {
        await assertVisualBibleReadyForImages(input.outputDir, input.visualBible, workingNovel, cards!.characters);
        if (this.options.imageSelfCheck && !configIsUsable(input.vision, "vision")) {
          throw new Error("图像自检已启用，但图片识别 API 未配置或不可用；请先在 API 配置页完成配置");
        }
        log({ step: "图像", message: "开始处理图像素材…", level: "info", at: Date.now() });
        const imageFeedback = this.feedback.image;
        const imageForce = !!imageFeedback || input.forceStages?.includes("image");
        const baseSeed = imageSeedFor(cards!.title || workingNovel.fileName, this.options);
        // 单章节模式：rerunChapters（novel 原始 index）→ chapters 数组位置集合（与配音 scope 同口径）
        // 纯追加模式：只处理新章位置（无视 rerunChapters）
        let imageChapterScope: Set<number> | undefined;
        if (this.appendedIndexes.length) {
          const wanted = new Set(this.appendedIndexes);
          imageChapterScope = new Set(
            this.activeChapterIndexes.map((novelIdx, pos) => (wanted.has(novelIdx) ? pos : -1)).filter((p) => p >= 0),
          );
          log({ step: "图像", message: `增量追加：仅处理新增的 ${imageChapterScope.size} 章背景/CG，其余复用已有映射`, level: "info", at: Date.now() });
        } else if (this.activeChapterIndexes.length && Array.isArray(this.options.rerunChapters)) {
          const selected = new Set(this.options.rerunChapters);
          imageChapterScope = new Set(
            this.activeChapterIndexes.map((novelIdx, pos) => (selected.has(novelIdx) ? pos : -1)).filter((p) => p >= 0),
          );
          log({
            step: "图像",
            message: imageChapterScope.size > 0
              ? `单章节模式：仅处理 ${imageChapterScope.size} 章的背景/CG，其余章节复用已有映射`
              : "未选中任何章节，仅复用已有图像映射",
            level: "info",
            at: Date.now(),
          });
        }
        const { images, failed, generated } = await generateImages(
          input.image,
          chapters,
          cards!,
          input.materials,
          this.cacheRoot,
          input.log,
          // 图像并发封顶 8：即使用户配置 30，也避免同时打爆第三方图片服务触发 429
          Math.min(8, concurrencyFor(input.image, "image")),
          this.options.figureEmotions,
          this.options.imageStyle,
          imageFeedback,
          imageForce,
          // 三视图与动作立绘均由 characterPoses 开关控制（动作图依赖三视图作图生图基准）；
          // figureActions 仅控制渲染侧入场/情绪动画，不影响是否生成动作图
          this.options.characterPoses !== false,
          this.options.characterPoses !== false,
          this.options.imageSelfCheck ? input.vision : undefined,
          baseSeed,
          this.options.styleAnchor !== false,
          () => this.aborted,
          input.visualBible,
          input.vision,
          input.llm,
          this.options.cgPerChapter ?? 0,
          this.options.imageBudgetPerChapter ?? 0,
          imageChapterScope,
          this.options.figureDetail ?? "full",
        );
        this.failedTasks.push(...failed);
        this.imageHadFailures = this.imageHadFailures || failed.length > 0;
        // 费用按实际 API 生成数计（缓存复用/用户素材拷贝不计费），不再按映射总数估算
        this.cost.imageCount = generated;
        this.cost.imageCostYuan = this.cost.imageCount * DEFAULT_PRICES.imageYuanEach;
        // 合并而非覆盖：分阶段/中断重跑时保留历史已生成映射
        Object.assign(assets.bg, images.bg);
        Object.assign(assets.cg, images.cg);
        Object.assign(assets.figure, images.figure);
        Object.assign(assets.item, images.item);
        await this.persistAssets(assets);
        this.checkAbort();
        logger.info("pipeline", "图像阶段完成", {
          generated,
          bg: Object.keys(images.bg).length,
          cg: Object.keys(images.cg).length,
          figure: Object.keys(images.figure).length,
          item: Object.keys(images.item).length,
          failed: failed.length,
        });
      } else {
        log({
          step: "图像",
          message: "图像生成已关闭或未配置图像 API，跳过",
          level: "warn",
          at: Date.now(),
        });
      }
    } else {
      log({ step: "图像", message: "未勾选图像阶段，复用已有素材", level: "info", at: Date.now() });
    }

    /* ==================== ⑤ 配音 ==================== */
    if (stages.has("voice")) {
      // 阶段显式包含 voice 即用户主动要求配音（手动重配不依赖 useTts 开关），仅需已配置 TTS API
      if (input.tts?.apiKey) {
        const voiceForce = !!this.feedback.voice || input.forceStages?.includes("voice");
        // 分章节生成：rerunChapters（novel 原始 index 集合）→ chapters 数组位置集合。
        // activeChapterIndexes[i] 对应重编号前的 chapters[i]，两侧同一口径。
        let chapterScope: Set<number> | undefined;
        if (this.appendedIndexes.length) {
          // 纯追加模式：只配新章
          const wanted = new Set(this.appendedIndexes);
          chapterScope = new Set(
            this.activeChapterIndexes.map((novelIdx, pos) => (wanted.has(novelIdx) ? pos : -1)).filter((p) => p >= 0),
          );
          log({ step: "配音", message: `增量追加：仅处理新增的 ${chapterScope.size} 章配音`, level: "info", at: Date.now() });
        } else if (this.activeChapterIndexes.length && Array.isArray(this.options.rerunChapters)) {
          const selected = new Set(this.options.rerunChapters);
          chapterScope = new Set(
            this.activeChapterIndexes.map((novelIdx, pos) => (selected.has(novelIdx) ? pos : -1)).filter((p) => p >= 0),
          );
        }
        if (chapterScope?.size === 0) {
          log({ step: "配音", message: "未选中任何章节，跳过配音生成", level: "warn", at: Date.now() });
        } else {
          log({ step: "配音", message: "开始生成配音…", level: "info", at: Date.now() });
          const { vocal, failed: voiceFailed, chars: voiceChars } = await generateVoice(input.tts, chapters, cards!.characters, this.cacheRoot, input.log, concurrencyFor(input.tts, "tts"), voiceForce, () => this.aborted, chapterScope);
          this.failedTasks.push(...voiceFailed);
          this.cost.ttsChars = voiceChars;
          this.cost.ttsCostYuan = (this.cost.ttsChars / 1e6) * DEFAULT_PRICES.ttsYuanPer1mChars;
          // 合并而非覆盖：分章节配音重跑时保留历史配音，返回体即全量
          Object.assign(assets.vocal, vocal);
          await this.persistAssets(assets);
          logger.info("pipeline", "配音阶段完成", { vocalCount: Object.keys(vocal).length, chapterScope: chapterScope ? chapterScope.size : "all" });
        }
      } else {
        log({ step: "配音", message: "配音已关闭或未配置 TTS API，跳过", level: "warn", at: Date.now() });
      }
    } else {
      log({ step: "配音", message: "未勾选配音阶段，复用已有配音", level: "info", at: Date.now() });
    }

    this.checkAbort();

    /* ==================== ⑥ 组装 ==================== */
    // 单章节模式保护：已有游戏成品时，若有章节因无缓存被跳过则禁止组装，
    // 否则组装会删掉这些章节的旧场景文件导致游戏缩水；全新项目（无 meta）允许渐进式组装。
    if (input.requireFullScriptCoverage && stages.has("assemble") && this.skippedScriptChapters.length > 0) {
      const hadGame = await this.loadMeta();
      if (hadGame) {
        throw new Error(
          `单章节模式已中止组装以保护已有游戏内容：以下章节缺少剧本缓存：${this.skippedScriptChapters.join("、")}。` +
            "请先用「顺序生成未完成章节」或全量流程补齐这些章节，再重跑本章。",
        );
      }
      log({
        step: "组装",
        message: `渐进式组装：${this.skippedScriptChapters.length} 个章节暂无剧本（${this.skippedScriptChapters.join("、")}），先组装已有章节，后续章节生成后会自动补入`,
        level: "warn",
        at: Date.now(),
      });
    }
    let meta: ProjectMeta | null = null;
    if (stages.has("assemble") && this.imageHadFailures && stages.has("image")) {
      // 图像阶段存在失败/中断任务：跳过组装，避免产出缺图残次品。
      // 用户可在「失败项」重试补图后再组装（或手动勾选组装阶段重跑）。
      log({
        step: "组装",
        message: `图像阶段有 ${this.failedTasks.filter((f) => f.step === "图像").length} 个任务失败/中断，已跳过组装（可在「失败项」重试补图后再组装）`,
        level: "warn",
        at: Date.now(),
      });
      this.imageHadFailures = false;
      meta = await this.loadMeta();
      if (!meta) {
        meta = {
          title: cards!.title || workingNovel.fileName.replace(/\.txt$/i, ""),
          gameKey: gameKeyFor(cards!.title || workingNovel.fileName),
          chapterCount: chapters.length,
          charCount: cards!.characters.length,
          sceneCount: chapters.reduce((n, c) => n + c.scenes.length, 0),
          lineCount: chapters.reduce((n, c) => n + c.scenes.reduce((m, s) => m + s.lines.length, 0), 0),
          outputDir: input.outputDir,
          webgalVersion: "4.6.3",
          generatedAt: new Date().toISOString(),
        };
      }
    } else if (stages.has("assemble")) {
      log({ step: "组装", message: `组装项目到 ${input.outputDir}…`, level: "info", at: Date.now() });
      const r = await assembleProject({
        outputDir: input.outputDir,
        title: cards!.title || workingNovel.fileName.replace(/\.txt$/i, ""),
        gameKey: gameKeyFor(cards!.title || workingNovel.fileName),
        templateDir: input.templateDir,
        chapters,
        cards: cards!,
        assets,
        introCard: this.options.characterIntroCard,
        figureEmotions: this.options.figureEmotions,
        figureActions: this.options.figureActions,
        useBgm: this.options.useBgm,
        language: (this.options.language as WebgalLanguage) || "zh_CN",
        log: (m) => this.log(m, "info", "组装"),
      });
      meta = r.meta;
      log({ step: "组装", message: "项目组装完成！", level: "success", at: Date.now() });
    } else {
      meta = await this.loadMeta();
      if (!meta) {
        meta = {
          title: cards!.title || workingNovel.fileName.replace(/\.txt$/i, ""),
          gameKey: gameKeyFor(cards!.title || workingNovel.fileName),
          chapterCount: chapters.length,
          charCount: cards!.characters.length,
          sceneCount: chapters.reduce((n, c) => n + c.scenes.length, 0),
          lineCount: chapters.reduce((n, c) => n + c.scenes.reduce((m, s) => m + s.lines.length, 0), 0),
          outputDir: input.outputDir,
          webgalVersion: "4.6.3",
          generatedAt: new Date().toISOString(),
        };
      }
      log({ step: "组装", message: "未勾选组装阶段，复用已有输出（可前往预览页试玩）", level: "info", at: Date.now() });
    }

    runStart("完成");
    logger.info("pipeline", "管线运行结束", {
      cost: this.cost,
      failedTasks: this.failedTasks.length,
      chapters: chapters.length,
      stages: Array.from(stages),
    });

    if (this.failedTasks.length) {
      log({
        step: "完成",
        message: `有 ${this.failedTasks.length} 个任务失败（已跳过，可在「失败项」定位重试；重新生成时已完成的会复用缓存，只补失败项）`,
        level: "warn",
        at: Date.now(),
      });
    }

    await this.persistFailedTasks();

    return { meta, cards: cards!, chapters, assets, cost: this.cost, failedTasks: this.failedTasks, splitChapters: workingChapters, splitMethod: this.lastSplitMethod, splitDiscarded: this.lastSplitDiscarded };
  }

  private checkAbort(): void {
    if (this.aborted) {
      throw new Error("已中止");
    }
  }
}
