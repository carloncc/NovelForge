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
import { extractFromNovel, demoExtract } from "./extract";
import { extractFromNovelAgent } from "./extractAgent";
import { scriptChapter, demoScriptAll } from "./script";
import { translateChapter } from "./translate";
import { aiSplitChapters, splitChaptersForFallback } from "./split";
import { generateImages } from "./images";
import { generateVoice } from "./voice";
import { assembleProject, gameKeyFor } from "./project";
import { cacheDirFor } from "./cache";
import { tauri } from "../utils/tauri";
import { errMsg } from "../utils/errors";
import { log as logger } from "../utils/logger";
import { configIsUsable } from "../api/providers";
import { concurrencyFor } from "../stores/configMigration";
import { setLlmConcurrency } from "../api/openaiCompatible";
import { assertVisualBibleApprovalStatus, assertVisualBibleReadyForImages } from "./visualBible";

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
}

export const DEFAULT_PRICES = {
  llmInYuanPer1m: 2,
  llmOutYuanPer1m: 8,
  imageYuanEach: 0.3,
  ttsYuanPer1mChars: 500,
};

export function titleHash(title: string): string {
  let h = 5381;
  for (const ch of title) {
    h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  }
  return h.toString(36);
}

/**
 * LLM 文本错误是否值得自动重试：网络/限流/5xx/服务端临时/JSON 解析类可重试；
 * 参数/鉴权/模型不存在等配置类错误不重试（避免浪费调用）。
 */
function isRetryableTextError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  if (/timeout|timed ?out|network|socket|connect|ec?onn|etimedout|fetch failed|econnrefused|econnreset|broken pipe|server error|unavailable|overloaded|busy|internal|too many|rate limit|429|5\d\d|无法从响应中提取合法 JSON|JSON 无法解析|已中止/i.test(message)) {
    return true;
  }
  if (/400|401|403|404|invalid api key|unauthorized|permission|not found|does not exist|unsupported|not supported|不支持|不可用|参数|鉴权|模型.{0,12}(?:不可用|不存在|未找到)/i.test(message)) {
    return false;
  }
  return true;
}

/**
 * LLM 文本调用失败自动重试：指数退避（3s→6s→…），尊重中止；配置类错误不重试直接抛出。
 */
async function withTextRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; isAborted?: () => boolean; onRetry?: (attempt: number, delayMs: number, err: unknown) => void },
): Promise<T> {
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (opts.isAborted?.()) throw new Error("已中止");
      if (attempt >= retries || !isRetryableTextError(e)) throw e;
      const delay = (opts.baseDelayMs ?? 3000) * 2 ** attempt;
      opts.onRetry?.(attempt + 1, delay, e);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** 小说全文指纹：源路径 + 正文内容哈希，用于分章/卡片缓存作废判断 */
function novelFingerprint(fullText: string): string {
  let h = 5381;
  for (const ch of fullText) {
    h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  }
  return `${fullText.length}:${h.toString(36)}`;
}

/** 分章入口：有 LLM 用 AI 分章，无 LLM 用规则回退 */
async function splitNovelForPipeline(
  cfg: ApiConfig | undefined,
  fullText: string,
  onUsage?: (pt: number, ct: number) => void,
  feedback?: string,
  concurrency = 3,
): Promise<ChapterInfo[]> {
  if (!cfg?.apiKey) {
    return splitChaptersForFallback(fullText);
  }
  return aiSplitChapters(cfg, fullText, onUsage, 40000, feedback, concurrency);
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
  }

  private checkBudget(): void {
    const b = this.options.budgetYuan ?? 0;
    if (b > 0) {
      const total = this.cost.llmCostYuan + this.cost.imageCostYuan + this.cost.ttsCostYuan;
      if (total > b) {
        throw new Error(`超出预算 ¥${b}（本次累计 ¥${total.toFixed(2)}），已中止；可调高预算或勾选「跳过缓存」重跑`);
      }
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

  private async loadChapters(): Promise<ChapterScript[]> {
    try {
      const entries = await tauri.listDir(this.cacheRoot);
      const files = entries
        .filter((e) => !e.isDir && /^script(_demo)?_ch\d+_/.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      const chapters: ChapterScript[] = [];
      for (const f of files) {
        try {
          const { text } = await tauri.readTextFile(f.path);
          const sc = JSON.parse(text) as ChapterScript;
          chapters[sc.chapter] = sc;
        } catch {
          /* 单个缓存损坏跳过 */
        }
      }
      return chapters.filter(Boolean);
    } catch {
      return [];
    }
  }

  private async loadAssetMap(): Promise<AssetMap | null> {
    return this.readCachedJson<AssetMap>(`${this.input.outputDir}/.novel2vn/assets.json`);
  }

  private async loadMeta(): Promise<ProjectMeta | null> {
    return this.readCachedJson<ProjectMeta>(`${this.input.outputDir}/.novel2vn/meta.json`);
  }

  private async persistAssets(assets: RenderAssets): Promise<void> {
    try {
      await tauri.writeTextFile(
        `${this.input.outputDir}/.novel2vn/assets.json`,
        JSON.stringify(
          { bg: assets.bg, cg: assets.cg, figure: assets.figure, item: assets.item, vocal: assets.vocal },
          null,
          2,
        ),
      );
    } catch {
      /* 素材映射持久化失败不阻断 */
    }
  }

  /** 卡片变化后使依赖卡片的缓存失效：剧本 + 立绘/物品图 */
  private async invalidateAfterCardsChange(): Promise<{ script: number; images: number }> {
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

  private async loadSplitChapters(): Promise<ChapterInfo[] | null> {
    const parsed = await this.readCachedJson<{ fp: string; chapters: ChapterInfo[] }>(this.splitCacheFile());
    if (!parsed || !Array.isArray(parsed.chapters) || !parsed.chapters.length) return null;
    const currentFp = novelFingerprint(this.input.novel.fullText);
    if (parsed.fp !== currentFp) {
      logger.warn("pipeline", "分章缓存与当前小说内容不一致，已忽略", {
        cached: parsed.fp.slice(0, 12),
        current: currentFp.slice(0, 12),
      });
      return null;
    }
    return parsed.chapters;
  }

  private async runSplit(): Promise<ChapterInfo[]> {
    const fullText = this.input.novel.fullText;
    const fp = novelFingerprint(fullText);
    const force = this.input.forceStages?.includes("split") || this.feedback.split;
    const skipCache = this.options.skipCache;
    if (!force && !skipCache) {
      const cached = await this.loadSplitChapters();
      if (cached) {
        this.input.log({
          step: "分章",
          message: `[缓存] 复用已分章结果（${cached.length} 章）`,
          level: "info",
          at: Date.now(),
        });
        return cached;
      }
    }
    this.input.log({
      step: "分章",
      message: "开始 AI 分章（识别章节标题并切分正文）…",
      level: "info",
      at: Date.now(),
    });
    const feedback = this.feedback.split;
    const chapters = await withTextRetry(
      () => splitNovelForPipeline(this.input.llm!, fullText, this.onUsageCb, feedback, concurrencyFor(this.input.llm, "llm")),
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
    await tauri.mkdirAll(this.cacheRoot);
    await tauri.writeTextFile(this.splitCacheFile(), JSON.stringify({ fp, chapters }, null, 2));
    return chapters;
  }

  /* ---------- 翻译：把小说章节翻译为目标语言（缓存于 .novel2vn/translate/，不被提取指纹清理） ---------- */

  private translateCacheFile(lang: string, ch: { index: number; title: string; text: string }): string {
    return `${this.input.outputDir}/.novel2vn/translate/translate_${lang}_ch${ch.index + 1}_${titleHash(ch.title)}_${titleHash(ch.text)}.json`;
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
          this.checkBudget();
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
      workingChapters = await this.runSplit();
      log({
        step: "分章",
        message: `分章完成：共 ${workingChapters.length} 章`,
        level: "success",
        at: Date.now(),
      });
    } else if (!input.novel.chapters.length || (input.novel.chapters.length === 1 && input.novel.chapters[0].text === input.novel.fullText)) {
      // 未勾选分章，且导入时是未切章状态（单章=全文）→ 需要从缓存恢复 AI 分章结果
      const cachedSplit = await this.loadSplitChapters();
      if (cachedSplit) {
        workingChapters = cachedSplit;
        log({ step: "分章", message: `[缓存] 复用已分章结果（${cachedSplit.length} 章）`, level: "info", at: Date.now() });
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
      // 小说指纹：源文件路径 + 章节正文内容哈希（不含章节标题，改标题不触发缓存作废）
      const bodyText = workingChapters.map((c) => c.text).join("\u0001");
      let fpHash = 5381;
      for (const ch of bodyText) {
        fpHash = ((fpHash * 33) ^ ch.codePointAt(0)!) >>> 0;
      }
      const novelFp = `${input.novel.sourcePath}:${fpHash.toString(36)}`;
      if (!cards && !this.options.skipCache && !extractFeedback && !forceExtract) {
        cards = (await this.readCachedJson<ExtractionResult>(cardsCache)) ?? undefined;
        if (cards && (cards as { _novelFp?: string })._novelFp !== novelFp) {
          log({
            step: "提取",
            message: "检测到小说内容变化（或更换了小说），旧缓存已作废，正在清理…",
            level: "warn",
            at: Date.now(),
          });
          await tauri.removePath(this.cacheRoot).catch(() => {});
          await tauri.mkdirAll(this.cacheRoot);
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
        await tauri.writeTextFile(cardsCache, JSON.stringify({ ...cards, _novelFp: novelFp }, null, 2));
        if (extractFeedback || forceExtract) {
          const cleared = await this.invalidateAfterCardsChange();
          this.log(`重新提取完成，已使 ${cleared.script} 个剧本缓存 / ${cleared.images} 个立绘物品图缓存失效，后续阶段将使用新卡片`, "success", "提取");
        }
        this.checkBudget();
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
      const scriptForce = input.forceStages?.includes("script");
      const rerunSet = new Set(
        scriptForce ? activeChapters.map((c) => c.index) : (this.options.rerunChapters ?? activeChapters.map((c) => c.index)),
      );
      const feedbackSet = new Set(Object.keys(this.feedback.script ?? {}).map(Number));
      const style = (this.options.scriptStyle ?? "").trim();
      const styleFrag = style ? `_st${titleHash(style)}` : "";
      const scriptTotal = activeChapters.length;
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
      let scriptIdx = 0;
      const scriptWorker = async (): Promise<void> => {
        while (scriptIdx < activeChapters.length) {
          const pos = scriptIdx++;
          const chapter = activeChapters[pos];
          this.checkAbort();
          const cacheFile = `${cacheDir}/${demo ? "script_demo" : "script"}_ch${chapter.index + 1}_${titleHash(chapter.title)}${styleFrag}.json`;
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
              this.checkBudget();
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
    } else {
      const cachedChapters = await this.loadChapters();
      if (cachedChapters.length) {
        for (const c of cachedChapters) {
          this.applyVideoOptions(c);
          ensureUniqueSceneIds(c);
          chapters.push(c);
        }
        log({ step: "剧本", message: `[缓存] 复用 ${chapters.length} 章剧本`, level: "info", at: Date.now() });
      } else {
        throw new Error("未勾选「剧本」阶段且无剧本缓存，请先勾选剧本或加载已有项目");
      }
    }
    logger.info("pipeline", "剧本阶段完成", { totalChapters: chapters.length });

    // 章节重新编号（过滤未启用的章节后）→ 图像/配音/组装使用统一编号，保证素材键一致
    chapters.forEach((c, i) => {
      c.chapter = i;
    });

    const assets: RenderAssets = { bg: {}, cg: {}, figure: {}, item: {}, vocal: {}, bgm: {} };

    // 未勾选图像/配音时，从磁盘恢复已生成的素材映射
    if (!stages.has("image") || !stages.has("voice")) {
      const existing = await this.loadAssetMap();
      if (existing) {
        assets.bg = existing.bg ?? {};
        assets.cg = existing.cg ?? {};
        assets.figure = existing.figure ?? {};
        assets.item = existing.item ?? {};
        assets.vocal = existing.vocal ?? {};
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
        const { images, failed } = await generateImages(
          input.image,
          chapters,
          cards!,
          input.materials,
          this.cacheRoot,
          input.log,
          concurrencyFor(input.image, "image"),
          this.options.figureEmotions,
          this.options.imageStyle,
          imageFeedback,
          imageForce,
          this.options.characterPoses !== false,
          this.options.characterPoses !== false,
          this.options.imageSelfCheck ? input.vision : undefined,
          baseSeed,
          this.options.styleAnchor !== false,
          () => this.aborted,
          input.visualBible,
          input.vision,
        );
        this.failedTasks.push(...failed);
        this.cost.imageCount = Object.values(images.bg).length + Object.values(images.cg).length + Object.values(images.figure).length + Object.values(images.item).length;
        this.cost.imageCostYuan = this.cost.imageCount * DEFAULT_PRICES.imageYuanEach;
        Object.assign(assets, images);
        await this.persistAssets(assets);
        this.checkBudget();
        this.checkAbort();
        logger.info("pipeline", "图像阶段完成", {
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
      if (this.options.useTts && input.tts?.apiKey) {
        log({ step: "配音", message: "开始生成配音…", level: "info", at: Date.now() });
        const voiceForce = !!this.feedback.voice || input.forceStages?.includes("voice");
        const vocal = await generateVoice(input.tts, chapters, cards!.characters, this.cacheRoot, input.log, concurrencyFor(input.tts, "tts"), voiceForce, () => this.aborted);
        this.cost.ttsChars = Object.keys(vocal).reduce((n, k) => n + (vocal[k] ? 1 : 0), 0) * 20;
        this.cost.ttsCostYuan = (this.cost.ttsChars / 1e6) * DEFAULT_PRICES.ttsYuanPer1mChars;
        assets.vocal = vocal;
        await this.persistAssets(assets);
        this.checkBudget();
        logger.info("pipeline", "配音阶段完成", { vocalCount: Object.keys(vocal).length });
      } else {
        log({ step: "配音", message: "配音已关闭或未配置 TTS API，跳过", level: "warn", at: Date.now() });
      }
    } else {
      log({ step: "配音", message: "未勾选配音阶段，复用已有配音", level: "info", at: Date.now() });
    }

    this.checkAbort();

    /* ==================== ⑥ 组装 ==================== */
    let meta: ProjectMeta | null = null;
    if (stages.has("assemble")) {
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

    return { meta, cards: cards!, chapters, assets, cost: this.cost, failedTasks: this.failedTasks, splitChapters: workingChapters };
  }

  private checkAbort(): void {
    if (this.aborted) {
      throw new Error("已中止");
    }
  }
}
