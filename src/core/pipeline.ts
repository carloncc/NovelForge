import type {
  ApiConfig,
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
} from "./types";
import type { RenderAssets } from "./render";
import { chatCompletion } from "../api/openaiCompatible";
import { extractFromNovel, demoExtract } from "./extract";
import { scriptChapter, demoScriptAll } from "./script";
import { generateImages } from "./images";
import { generateVoice } from "./voice";
import { assembleProject, gameKeyFor } from "./project";
import { cacheDirFor } from "./cache";
import { tauri } from "../utils/tauri";

export interface PipelineInput {
  novel: NovelDoc;
  cards?: ExtractionResult;
  llm?: ApiConfig;
  image?: ApiConfig;
  tts?: ApiConfig;
  materials: MaterialAsset[];
  outputDir: string;
  templateDir: string;
  options: GenerationOptions;
  log: (ev: PipelineEvent) => void;
}

export const DEFAULT_PRICES = {
  llmInYuanPer1m: 2,
  llmOutYuanPer1m: 8,
  imageYuanEach: 0.3,
  ttsYuanPer1mChars: 500,
};

function titleHash(title: string): string {
  let h = 5381;
  for (const ch of title) {
    h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  }
  return h.toString(36);
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

  async run(): Promise<PipelineResult> {
    const { input } = this;
    this.cacheRoot = `${input.outputDir}/.novel2vn/cache`;
    await tauri.mkdirAll(this.cacheRoot);
    const cacheDir = cacheDirFor(this.cacheRoot, "");

    const log = input.log;
    const onUsage = (pt: number, ct: number) => {
      this.cost.llmTokens += pt + ct;
      this.cost.llmCostYuan += (pt / 1e6) * DEFAULT_PRICES.llmInYuanPer1m + (ct / 1e6) * DEFAULT_PRICES.llmOutYuanPer1m;
    };

    const demo = !input.llm?.apiKey;
    if (demo) {
      log({
        step: "提取",
        message: "未配置文本 LLM API，使用演示模式（内置示例小说的角色/场景/物品卡）",
        level: "warn",
        at: Date.now(),
      });
    }

    // ① 提取
    log({ step: "提取", message: "开始提取角色/场景/物品卡…", level: "info", at: Date.now() });
    let cards: ExtractionResult | undefined = input.cards;
    const cachePrefix = demo ? "cards_demo" : "cards";
    const cardsCache = `${input.outputDir}/.novel2vn/${cachePrefix}.json`;
    // 小说指纹：源文件路径 + 章节正文内容哈希（不含章节标题，改标题不触发缓存作废）
    const bodyText = input.novel.chapters.map((c) => c.text).join("\u0001");
    let fpHash = 5381;
    for (const ch of bodyText) {
      fpHash = ((fpHash * 33) ^ ch.codePointAt(0)!) >>> 0;
    }
    const novelFp = `${input.novel.sourcePath}:${fpHash.toString(36)}`;
    if (!cards && !this.options.skipCache) {
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
        cards = demo
          ? demoExtract(input.novel.fullText, input.novel.fileName.replace(/\.txt$/i, ""))
          : await extractFromNovel(input.llm!, input.novel.fullText, input.novel.fileName.replace(/\.txt$/i, ""), onUsage);
      } catch (e) {
        this.recordFailure({
          id: "extract",
          kind: "llm",
          step: "提取",
          message: (e as Error).message,
          at: Date.now(),
        });
        throw e;
      }
      await tauri.writeTextFile(cardsCache, JSON.stringify({ ...cards, _novelFp: novelFp }, null, 2));
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
    this.checkAbort();

    // ② 分章剧本
    const chapters: ChapterScript[] = [];
    const activeChapters = input.novel.chapters.filter((c) => c.enabled !== false);
    const rerunSet = new Set(this.options.rerunChapters ?? activeChapters.map((c) => c.index));
    for (const chapter of activeChapters) {
      this.checkAbort();
      const cacheFile = `${cacheDir}/${demo ? "script_demo" : "script"}_ch${chapter.index + 1}_${titleHash(chapter.title)}.json`;
      const selected = rerunSet.has(chapter.index);
      let script: ChapterScript | null = null;
      if (!selected) {
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
        if (!this.options.skipCache) {
          script = await this.readCachedJson<ChapterScript>(cacheFile);
        }
        if (!script) {
          log({
            step: "剧本",
            message: `生成第 ${chapter.index + 1} 章剧本：${chapter.title}`,
            level: "info",
            at: Date.now(),
          });
          try {
            script = demo
              ? demoScriptAll([chapter], cards!)[0]
              : await scriptChapter(input.llm!, chapter, cards!, onUsage);
          } catch (e) {
            this.recordFailure({
              id: `chapter_${chapter.index + 1}`,
              kind: "script",
              step: "剧本",
              message: `第 ${chapter.index + 1} 章：${(e as Error).message}`,
              at: Date.now(),
            });
            throw e;
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
      // 视频推荐点：开关 + 数量上限
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
      ensureUniqueSceneIds(script);
      chapters.push(script);
    }

    const assets: RenderAssets = { bg: {}, cg: {}, figure: {}, item: {}, vocal: {}, bgm: {} };

    // ③ 图像（用户素材优先；无图像 API 时仅用用户素材）
    if (this.options.useImage) {
      log({ step: "图像", message: "开始处理图像素材…", level: "info", at: Date.now() });
      const { images, failed } = await generateImages(
        input.image,
        chapters,
        cards!,
        input.materials,
        this.cacheRoot,
        input.log,
        2,
        this.options.figureEmotions,
      );
      this.failedTasks.push(...failed);
      this.cost.imageCount = Object.values(images.bg).length + Object.values(images.cg).length + Object.values(images.figure).length + Object.values(images.item).length;
      this.cost.imageCostYuan = this.cost.imageCount * DEFAULT_PRICES.imageYuanEach;
      Object.assign(assets, images);
      this.checkBudget();
      this.checkAbort();
    } else {
      log({
        step: "图像",
        message: "图像生成已关闭或未配置图像 API，跳过",
        level: "warn",
        at: Date.now(),
      });
    }

    // ④ 配音
    if (this.options.useTts && input.tts?.apiKey) {
      log({ step: "配音", message: "开始生成配音…", level: "info", at: Date.now() });
      const vocal = await generateVoice(input.tts, chapters, cards!.characters, this.cacheRoot, input.log, 2);
      this.cost.ttsChars = Object.keys(vocal).reduce((n, k) => n + (vocal[k] ? 1 : 0), 0) * 20;
      this.cost.ttsCostYuan = (this.cost.ttsChars / 1e6) * DEFAULT_PRICES.ttsYuanPer1mChars;
      assets.vocal = vocal;
      this.checkBudget();
    } else {
      log({ step: "配音", message: "配音已关闭或未配置 TTS API，跳过", level: "warn", at: Date.now() });
    }

    this.checkAbort();

    // 章节重新编号（过滤未启用的章节后）
    chapters.forEach((c, i) => {
      c.chapter = i;
    });

    // ⑤ 组装
    log({ step: "组装", message: `组装项目到 ${input.outputDir}…`, level: "info", at: Date.now() });
    const { meta } = await assembleProject({
      outputDir: input.outputDir,
      title: cards!.title || input.novel.fileName.replace(/\.txt$/i, ""),
      gameKey: gameKeyFor(cards!.title || input.novel.fileName),
      templateDir: input.templateDir,
      chapters,
      cards: cards!,
      assets,
      introCard: this.options.characterIntroCard,
      figureEmotions: this.options.figureEmotions,
      useBgm: this.options.useBgm,
      log: (m) => this.log(m, "info", "组装"),
    });
    log({ step: "组装", message: "项目组装完成！", level: "success", at: Date.now() });

    return { meta, cards: cards!, chapters, assets, cost: this.cost, failedTasks: this.failedTasks };
  }

  private checkAbort(): void {
    if (this.aborted) {
      throw new Error("已中止");
    }
  }
}
