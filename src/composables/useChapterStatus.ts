import { reactive } from "vue";
import type { ApiConfig, ChapterScript, GenerationOptions, NovelDoc, PipelineResult } from "../core/types";
import { buildImageTasks } from "../core/images";
import { buildVoiceJobs } from "../core/voice";
import { scriptCacheRest, titleHash } from "../core/cache";
import { parseChapterScript } from "../core/dataValidation";
import { readAssetMap } from "../core/assetMap";
import { tauri } from "../utils/tauri";

/** 单章节内容灯：以 novel 原始 index 为键 */
export interface ChapterLight {
  /** 有与当前章节匹配的剧本缓存 */
  script: boolean;
  /** 只有旧版无指纹缓存（无法判定新旧） */
  legacyScript: boolean;
  imageDone: number;
  imageTotal: number;
  voiceDone: number;
  voiceTotal: number;
  /** 无 TTS 配置时为 true（配音灯不参与完成判定） */
  voiceSkipped: boolean;
}

export const emptyChapterLight = (): ChapterLight => ({
  script: false,
  legacyScript: false,
  imageDone: 0,
  imageTotal: 0,
  voiceDone: 0,
  voiceTotal: 0,
  voiceSkipped: true,
});

/** 单章内容是否完成（队列目标判定口径：剧本＋图像齐了即可，不含配音） */
export function isChapterContentComplete(l: ChapterLight): boolean {
  return l.script && l.imageTotal > 0 && l.imageDone >= l.imageTotal;
}

export interface ChapterStatusInput {
  getOutputDir: () => string;
  getNovel: () => NovelDoc | null;
  getOptions: () => GenerationOptions;
  getResult: () => PipelineResult | null;
  getTtsConfig: () => ApiConfig | undefined;
  /** 文本 LLM 是否可用（决定剧本缓存是正式版还是演示版前缀） */
  getLlmAvailable: () => boolean;
}

interface ScriptCacheEntry {
  pos: number;
  path: string;
  legacy: boolean;
}

export function useChapterStatus(input: ChapterStatusInput) {
  const lights = reactive<Record<number, ChapterLight>>({});
  /** 旧版无指纹缓存的章节数（提示重跑一次剧本纳入校验） */
  const legacy = reactive<{ count: number }>({ count: 0 });

  async function pathExists(p: string): Promise<boolean> {
    try {
      return await tauri.pathExists(p);
    } catch {
      return false;
    }
  }

  /** 与管线一致的翻译还原：语言开启时用已翻译标题/正文算指纹，否则用原文 */
  async function effectiveText(
    dir: string,
    lang: string,
    ch: { index: number; title: string; text: string },
  ): Promise<{ title: string; text: string }> {
    if (!lang) return { title: ch.title, text: ch.text };
    try {
      // 与管线 translateCacheFile 同格式（去序号，只认标题＋正文哈希）
      const file = `${dir}/.novel2vn/translate/translate_${lang}_${titleHash(ch.title)}_${titleHash(ch.text)}.json`;
      if (await pathExists(file)) {
        const { text } = await tauri.readTextFile(file);
        const parsed = JSON.parse(text) as { title?: string; text?: string };
        if (typeof parsed.title === "string" && typeof parsed.text === "string") {
          return { title: parsed.title, text: parsed.text };
        }
      }
    } catch {
      /* 无译文缓存则回退原文 */
    }
    return { title: ch.title, text: ch.text };
  }

  async function loadCards(dir: string): Promise<{ id: string; name: string }[] | null> {
    for (const f of ["cards.json", "cards_demo.json"]) {
      try {
        const { text } = await tauri.readTextFile(`${dir}/.novel2vn/${f}`);
        const parsed = JSON.parse(text) as { characters?: { id: string; name: string }[] };
        if (parsed && Array.isArray(parsed.characters)) return parsed.characters;
      } catch {
        /* 换下一个 */
      }
    }
    return input.getResult()?.cards.characters ?? null;
  }

  async function refresh(): Promise<void> {
    const dir = input.getOutputDir();
    const novel = input.getNovel();
    if (!dir || !novel) return;
    const options = input.getOptions();
    const enabled = novel.chapters.filter((c) => c.enabled !== false);
    const style = (options.scriptStyle ?? "").trim();
    const styleFrag = style ? `_st${titleHash(style)}` : "";
    const demo = !input.getLlmAvailable();
    const cacheDir = `${dir}/.novel2vn/cache`;
    const lang = (options.language ?? "").trim();

    // 各章节期望键（翻译感知）
    const expectedByIndex = new Map<number, string>();
    for (const ch of enabled) {
      const eff = await effectiveText(dir, lang, ch);
      expectedByIndex.set(ch.index, scriptCacheRest(eff.title, eff.text, styleFrag));
    }

    // 扫描剧本缓存并分类
    let entries: { name: string; path: string; isDir: boolean }[] = [];
    try {
      entries = (await tauri.listDir(cacheDir)) as { name: string; path: string; isDir: boolean }[];
    } catch {
      entries = [];
    }
    const picked = new Map<number, ScriptCacheEntry>();
    let legacyCount = 0;
    for (const e of entries
      .filter((x) => !x.isDir && /^script(_demo)?_ch\d+_/.test(x.name))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const m = e.name.match(/^script(_demo)?_ch(\d+)_(.+)\.json$/);
      if (!m) continue;
      // demo/正式隔离：同文同风时两套指纹体相同，不隔离会被对方覆盖
      if (!!m[1] !== demo) continue;
      const n = parseInt(m[2], 10) - 1;
      const rest = m[3];
      const expected = expectedByIndex.get(n);
      if (expected !== undefined && rest === expected) {
        picked.set(n, { pos: n, path: e.path, legacy: false });
      } else if (!rest.includes("_t")) {
        // 旧版无指纹：兼容保留（字典序最新），计数提示
        picked.set(n, { pos: n, path: e.path, legacy: true });
        legacyCount++;
      }
      // 失配的新格式文件＝过期残留，直接忽略（下次跑剧本阶段自动清理）
    }
    legacy.count = legacyCount;

    // 素材映射与卡片只读一次
    let assets: { bg: Record<string, string>; cg: Record<string, string>; figure: Record<string, string>; item: Record<string, string>; vocal: Record<string, string> } = { bg: {}, cg: {}, figure: {}, item: {}, vocal: {} };
    try {
      const map = await readAssetMap(dir);
      assets = {
        bg: map.bg ?? {},
        cg: map.cg ?? {},
        figure: map.figure ?? {},
        item: map.item ?? {},
        vocal: map.vocal ?? {},
      };
    } catch {
      /* 无映射则全 0 */
    }
    const characters = (await loadCards(dir)) ?? [];
    const ttsCfg = input.getTtsConfig();

    for (const ch of enabled) {
      const light = emptyChapterLight();
      const hit = picked.get(ch.index);
      light.script = !!hit;
      light.legacyScript = hit?.legacy ?? false;
      if (hit) {
        let script: ChapterScript | null = null;
        try {
          const { text } = await tauri.readTextFile(hit.path);
          script = parseChapterScript(JSON.parse(text));
        } catch {
          script = null;
        }
        if (script) {
          // 图像覆盖率：与管线同口径（锚点除外）
          try {
            const tasks = buildImageTasks([script], { title: "", characters, scenes: [], items: [] } as never, {
              figurePerCharacter: 1,
              cgPerChapter: options.cgPerChapter ?? 0,
              maxPerChapter: options.imageBudgetPerChapter ?? 0,
              figureEmotions: options.figureEmotions,
              detail: options.figureDetail ?? "full",
              threeView: options.characterPoses !== false,
              actions: options.characterPoses !== false,
              styleAnchor: false,
            }).filter((t) => t.kind !== "anchor");
            light.imageTotal = tasks.length;
            light.imageDone = tasks.filter((t) => {
              if (t.kind === "background") return Boolean(assets.bg[t.id]);
              if (t.kind === "cg") return Boolean(assets.cg[t.id]);
              if (t.kind === "item") return Boolean(assets.item[t.id]);
              return Boolean(assets.figure[t.id]);
            }).length;
          } catch {
            /* 任务构建失败则保持 0 */
          }
          // 配音覆盖率：无 TTS 配置则跳过显示
          if (ttsCfg && characters.length) {
            try {
              const jobs = buildVoiceJobs(ttsCfg, [script], characters as never);
              light.voiceTotal = jobs.length;
              light.voiceDone = jobs.filter((j) => Boolean(assets.vocal[j.key])).length;
              light.voiceSkipped = false;
            } catch {
              /* 保持跳过 */
            }
          }
        }
      }
      lights[ch.index] = light;
    }
    // 下线章节清灯
    for (const k of Object.keys(lights).map(Number)) {
      if (!enabled.some((c) => c.index === k)) delete lights[k];
    }
  }

  return { lights, legacy, refresh };
}
