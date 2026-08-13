import { computed, reactive } from "vue";
import type { AssetMap, FailedTask, NovelDoc, StageKey } from "../core/types";
import { STAGE_LABELS, STAGE_ORDER } from "../core/types";
import { tauri } from "../utils/tauri";

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
}

/** 管线日志/失败的 step 标签 → StageKey */
export const STEP_TO_STAGE: Record<string, StageKey> = {
  [STAGE_LABELS.split]: "split",
  [STAGE_LABELS.translate]: "translate",
  [STAGE_LABELS.extract]: "extract",
  [STAGE_LABELS.script]: "script",
  [STAGE_LABELS.image]: "image",
  [STAGE_LABELS.voice]: "voice",
  [STAGE_LABELS.assemble]: "assemble",
};

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

  async function listDirCount(dir: string, match: (name: string) => boolean): Promise<number> {
    try {
      const entries = await tauri.listDir(dir);
      return entries.filter((e) => !e.isDir && match(e.name)).length;
    } catch {
      return 0;
    }
  }

  async function hasAssetEntries(dir: string, pick: (a: AssetMap) => Record<string, string>): Promise<boolean> {
    try {
      const { text } = await tauri.readTextFile(`${dir}/.novel2vn/assets.json`);
      const map = JSON.parse(text) as AssetMap;
      return Object.keys(pick(map)).length > 0;
    } catch {
      return false;
    }
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
    const [split, cards, meta] = await Promise.all([
      pathExists(`${metaDir}/split.json`),
      pathExists(`${metaDir}/cards.json`),
      pathExists(`${metaDir}/cards_demo.json`),
      pathExists(`${metaDir}/meta.json`),
    ]);
    base.split = split || (novel?.chapters.length ?? 0) > 1;
    base.extract = cards;
    base.assemble = meta;

    const activeCount = novel?.chapters.filter((c) => c.enabled !== false).length ?? 0;

    // 翻译：语言为空 = 无需执行；否则按当前语言统计译文缓存 ≥ 启用章节数
    const lang = input.getLanguage();
    if (!lang) {
      base.translate = true;
    } else {
      const translated = await listDirCount(`${metaDir}/translate`, (name) => name.startsWith(`translate_${lang}_ch`));
      base.translate = activeCount > 0 && translated >= activeCount;
    }

    // 剧本：script 缓存数量 ≥ 启用章节数
    const scriptFiles = await listDirCount(`${metaDir}/cache`, (name) => /^script(_demo)?_ch\d+_/.test(name));
    base.script = activeCount > 0 && scriptFiles >= activeCount;

    // 图像 / 配音：assets.json 相应字段非空
    base.image = await hasAssetEntries(dir, (a) => a.figure || a.bg || a.cg || a.item);
    base.voice = await hasAssetEntries(dir, (a) => a.vocal);
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
