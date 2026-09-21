import { computed, reactive } from "vue";
import type { ApiConfig, AssetMap, FailedTask, GenerationOptions, NovelDoc, PipelineResult, StageKey } from "../core/types";
import { STAGE_ORDER, STEP_TO_STAGE } from "../core/types";
import { buildImageTasks } from "../core/images";
import { buildVoiceJobs } from "../core/voice";
import { scriptCacheRest, scriptFingerprint, titleHash, cardsFingerprint } from "../core/cache";
import { tauri } from "../utils/tauri";
import { parseAssetMap } from "../core/assetMap";

export type StageState = "idle" | "running" | "done" | "failed";

export interface StageStatusInput {
  getOutputDir: () => string;
  getNovel: () => NovelDoc | null;
  /** 当前目标语言（空 = 未启用翻译） */
  getLanguage: () => string;
  getFailedTasks: () => FailedTask[];
  /** 日志中「最后一条」为 error 的阶段的集合（用于中断/未落盘运行的失败识别） */
  getLogFailedStages: () => Set<StageKey>;
  getBusy: () => boolean;
  /** 当前正在执行的阶段 */
  getRunningStages: () => StageKey[];
  getResult: () => PipelineResult | null;
  getOptions: () => GenerationOptions;
  getTtsConfig: () => ApiConfig | undefined;
  /** 文本 LLM 是否可用：决定提取阶段认哪份卡片（正式 cards.json / 演示 cards_demo.json，见 #792） */
  getLlmAvailable: () => boolean;
}

export function useStageStatus(input: StageStatusInput) {
  /** base：由产物/缓存文件判定的「已完成」状态（异步 refresh 更新） */
  const base = reactive<Record<StageKey, boolean>>({
    split: false,
    translate: false,
    extract: false,
    script: false,
    image: false,
    voice: false,
    assemble: false,
  });

  async function pathExists(p: string): Promise<boolean> {
    try {
      return await tauri.pathExists(p);
    } catch {
      return false;
    }
  }

  /** 与管线一致的翻译还原：语言开启且有译文缓存时，用译文标题/正文算剧本指纹 */
  async function effectiveChapter(
    metaDir: string,
    lang: string,
    ch: { title: string; text?: string },
  ): Promise<{ title: string; text: string }> {
    const title = ch.title;
    const text = ch.text || "";
    if (!lang) return { title, text };
    try {
      const f = `${metaDir}/translate/translate_${lang}_${titleHash(title)}_${titleHash(text)}.json`;
      if (!(await pathExists(f))) return { title, text };
      const { text: rawText } = await tauri.readTextFile(f);
      const parsed = JSON.parse(rawText) as { title?: string; text?: string };
      if (typeof parsed?.title === "string" && typeof parsed?.text === "string") {
        return { title: parsed.title, text: parsed.text };
      }
    } catch {
      /* 无译文缓存则回退原文 */
    }
    return { title, text };
  }

  /** 统计「与当前章节输入指纹匹配」的剧本缓存数（正式/演示前缀都认） */
  async function countFreshScripts(
    metaDir: string,
    lang: string,
    chapters: { index: number; title: string; text?: string }[],
    styleFrag: string,
  ): Promise<number> {
    let names: Set<string>;
    try {
      const entries = await tauri.listDir(`${metaDir}/cache`);
      names = new Set(entries.filter((e) => !e.isDir).map((e) => e.name));
    } catch {
      return 0;
    }
    let matched = 0;
    for (const ch of chapters) {
      const eff = await effectiveChapter(metaDir, lang, ch);
      const rest = scriptCacheRest(eff.title, eff.text, styleFrag);
      if (names.has(`script_ch${ch.index + 1}_${rest}.json`) || names.has(`script_demo_ch${ch.index + 1}_${rest}.json`)) matched++;
    }
    return matched;
  }

  /** 卡片指纹（剧本缓存键的一部分）：按当前模式优先读对应卡片文件；读不到时用空串（此时脚本计数必然为 0） */
  async function readCardsFingerprint(metaDir: string, formal: boolean): Promise<string> {
    for (const f of formal ? ["cards.json", "cards_demo.json"] : ["cards_demo.json", "cards.json"]) {
      try {
        const { text } = await tauri.readTextFile(`${metaDir}/${f}`);
        const parsed = JSON.parse(text) as { characters?: { id: string; name?: string }[] };
        if (Array.isArray(parsed.characters)) return cardsFingerprint(parsed);
      } catch {
        /* 换下一个 */
      }
    }
    return "";
  }

  async function assetMap(dir: string): Promise<AssetMap | undefined> {
    try {
      const { text } = await tauri.readTextFile(`${dir}/.novel2vn/assets.json`);
      return parseAssetMap(JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  function allExpectedImagesExist(map: AssetMap, result: PipelineResult, options: GenerationOptions): boolean {
    // 还没读到任何剧本（restore 后 chapters 为空）时不能判「完成」：Array.every 对空数组恒为 true
    if (!result.chapters.length) return false;
    const tasks = buildImageTasks(result.chapters, result.cards, {
      cgPerChapter: options.cgPerChapter ?? 0,
      maxPerChapter: options.imageBudgetPerChapter ?? 0,
      figureEmotions: options.figureEmotions,
      detail: options.figureDetail ?? "full",
      style: options.imageStyle,
      threeView: options.characterPoses !== false,
      actions: options.characterPoses !== false,
      styleAnchor: options.styleAnchor !== false,
    });
    return tasks.every((task) => {
      if (task.kind === "anchor") return true;
      if (task.kind === "background") return Boolean(map.bg[task.id]);
      if (task.kind === "cg") return Boolean(map.cg[task.id]);
      if (task.kind === "item") return Boolean(map.item[task.id]);
      return Boolean(map.figure[task.id]);
    });
  }

  function allExpectedVoicesExist(map: AssetMap, result: PipelineResult, config: ApiConfig): boolean {
    // 同上：无剧本时不判完成，避免「0 条配音也全绿」
    if (!result.chapters.length) return false;
    return buildVoiceJobs(config, result.chapters, result.cards.characters)
      .every((job) => Boolean(map.vocal[job.key]));
  }

  /** B30：刷新并发令牌。多次 refresh 重叠时（配置/卡片变化与运行结束几乎同时触发），
   *  旧的一次可能晚于新的一次完成，用过期结果覆盖新状态；令牌变化即丢弃本次写入。 */
  let refreshToken = 0;

  /** 依据产物/缓存文件刷新「完成」状态 */
  async function refresh(): Promise<void> {
    const token = ++refreshToken;
    const dir = input.getOutputDir();
    const novel = input.getNovel();
    if (!dir) {
      if (token !== refreshToken) return;
      for (const k of STAGE_ORDER) base[k] = false;
      return;
    }
    const metaDir = `${dir}/.novel2vn`;
    const [split, cards, demoCards, meta, cardsFp] = await Promise.all([
      pathExists(`${metaDir}/split.json`),
      pathExists(`${metaDir}/cards.json`),
      pathExists(`${metaDir}/cards_demo.json`),
      pathExists(`${metaDir}/meta.json`),
      readCardsFingerprint(metaDir, input.getLlmAvailable()),
    ]);
    if (token !== refreshToken) return;
    base.split = split || (novel?.chapters.length ?? 0) > 1;
    // demo/正式隔离（#792）：提取阶段只看当前模式对应的卡片文件，
    // 否则演示模式会被正式 cards.json 点绿（或反之），与剧本缓存前缀口径不一致
    base.extract = input.getLlmAvailable() ? cards : demoCards;
    base.assemble = meta;

    const activeCount = novel?.chapters.filter((c) => c.enabled !== false).length ?? 0;
    const enabledChapters = (novel?.chapters ?? []).filter((c) => c.enabled !== false);

    // 翻译：语言为空 = 无需执行；否则逐章校验「标题＋正文哈希」命中的译文缓存
    // （不按文件数量统计：旧正文/旧版本残留文件会凑数，看板误判完成）
    const lang = input.getLanguage();
    if (!lang) {
      if (token !== refreshToken) return;
      base.translate = true;
    } else {
      let translated = 0;
      for (const ch of enabledChapters) {
        if (await pathExists(`${metaDir}/translate/translate_${lang}_${titleHash(ch.title)}_${titleHash(ch.text || "")}.json`)) translated++;
      }
      if (token !== refreshToken) return;
      base.translate = activeCount > 0 && translated >= activeCount;
    }

    // 剧本：逐章校验与「当前标题＋正文＋文风（翻译感知）」指纹匹配的缓存（正式/演示前缀都认），
    // 只有数量达标才判完成（旧实现只数文件个数，改写正文/换文风后旧残留仍会点绿）
    const styleFrag = (() => {
      const options = input.getOptions();
      return scriptFingerprint({ style: options.scriptStyle, compressNarration: options.compressNarration, cardsFp });
    })();
    const freshScripts = await countFreshScripts(metaDir, lang, enabledChapters, styleFrag);
    if (token !== refreshToken) return;
    base.script = activeCount > 0 && freshScripts >= activeCount;

    const options = input.getOptions();
    const result = input.getResult();
    const assets = await assetMap(dir);
    if (token !== refreshToken) return;
    base.image = !options.useImage || Boolean(assets && result && allExpectedImagesExist(assets, result, options));
    const ttsConfig = input.getTtsConfig();
    base.voice = !options.useTts || Boolean(assets && result && ttsConfig && allExpectedVoicesExist(assets, result, ttsConfig));
  }

  /** 失败集合：failedTasks（按 step 映射）∪ 日志最后一条为 error 的阶段 */
  const failedSet = computed<Set<StageKey>>(() => {
    const set = new Set<StageKey>(input.getLogFailedStages());
    for (const f of input.getFailedTasks()) {
      const k = STEP_TO_STAGE[f.step];
      if (k) set.add(k);
    }
    return set;
  });

  const stageStatus = computed<Record<StageKey, StageState>>(() => {
    const running = new Set(input.getRunningStages());
    const out = {} as Record<StageKey, StageState>;
    for (const k of STAGE_ORDER) {
      if (failedSet.value.has(k)) out[k] = "failed";
      else if (running.has(k)) out[k] = "running";
      else out[k] = base[k] ? "done" : "idle";
    }
    return out;
  });

  return { base, stageStatus, refresh, STEP_TO_STAGE };
}
