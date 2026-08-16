import { computed, reactive } from "vue";
import type { ApiConfig, AssetMap, FailedTask, GenerationOptions, NovelDoc, PipelineResult, StageKey } from "../core/types";
import { STAGE_ORDER, STEP_TO_STAGE } from "../core/types";
import { buildImageTasks } from "../core/images";
import { buildVoiceJobs } from "../core/voice";
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

  async function listUniqueChapters(dir: string, chapterFromName: (name: string) => string | null): Promise<number> {
    try {
      const entries = await tauri.listDir(dir);
      const chapters = new Set<string>();
      for (const entry of entries) {
        if (entry.isDir) continue;
        const chapter = chapterFromName(entry.name);
        if (chapter) chapters.add(chapter);
      }
      return chapters.size;
    } catch {
      return 0;
    }
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
    const tasks = buildImageTasks(result.chapters, result.cards, {
      figurePerCharacter: 1,
      cgPerChapter: 0,
      maxPerChapter: 0,
      figureEmotions: options.figureEmotions,
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
    return buildVoiceJobs(config, result.chapters, result.cards.characters)
      .every((job) => Boolean(map.vocal[job.key]));
  }

  /** 依据产物/缓存文件刷新「完成」状态 */
  async function refresh(): Promise<void> {
    const dir = input.getOutputDir();
    const novel = input.getNovel();
    if (!dir) {
      for (const k of STAGE_ORDER) base[k] = false;
      return;
    }
    const metaDir = `${dir}/.novel2vn`;
    const [split, cards, demoCards, meta] = await Promise.all([
      pathExists(`${metaDir}/split.json`),
      pathExists(`${metaDir}/cards.json`),
      pathExists(`${metaDir}/cards_demo.json`),
      pathExists(`${metaDir}/meta.json`),
    ]);
    base.split = split || (novel?.chapters.length ?? 0) > 1;
    base.extract = cards || demoCards;
    base.assemble = meta;

    const activeCount = novel?.chapters.filter((c) => c.enabled !== false).length ?? 0;

    // 翻译：语言为空 = 无需执行；否则按当前语言统计译文缓存 ≥ 启用章节数
    const lang = input.getLanguage();
    if (!lang) {
      base.translate = true;
    } else {
      const translated = await listUniqueChapters(`${metaDir}/translate`, (name) => {
        if (!name.startsWith(`translate_${lang}_ch`)) return null;
        return name.match(/_ch(\d+)_/)?.[1] ?? null;
      });
      base.translate = activeCount > 0 && translated >= activeCount;
    }

    // 剧本：script 缓存数量 ≥ 启用章节数
    const scriptFiles = await listUniqueChapters(
      `${metaDir}/cache`,
      (name) => name.match(/^script(?:_demo)?_ch(\d+)_/)?.[1] ?? null,
    );
    base.script = activeCount > 0 && scriptFiles >= activeCount;

    const options = input.getOptions();
    const result = input.getResult();
    const assets = await assetMap(dir);
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
