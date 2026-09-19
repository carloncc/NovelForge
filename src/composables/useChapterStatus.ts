import { reactive } from "vue";
import type { ApiConfig, ChapterScript, GenerationOptions, NovelDoc, PipelineResult } from "../core/types";
import { chapterScopeImageTasks } from "../core/chapterAssets";
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
  return l.script && (l.imageTotal === 0 || l.imageDone >= l.imageTotal);
}

export interface ChapterStatusInput {
  getOutputDir: () => string;
  getNovel: () => NovelDoc | null;
  getOptions: () => GenerationOptions;
  getResult: () => PipelineResult | null;
  getTtsConfig: () => ApiConfig | undefined;
  /** 文本 LLM 是否可用（决定剧本缓存是正式版还是演示版前缀） */
  getLlmAvailable: () => boolean;
  /** 图像生成 API 是否可用：未配置时图像灯不参与完成判定（否则章节永远差图、队列无法收敛） */
  getImageAvailable: () => boolean;
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

  /** 卡片（角色＋物品）：章节图像口径要按「本章出场角色/物品」收窄，所以物品也要读 */
  async function loadCards(
    dir: string,
  ): Promise<{ characters: { id: string; name: string }[]; items: { id: string; name: string }[] } | null> {
    for (const f of ["cards.json", "cards_demo.json"]) {
      try {
        const { text } = await tauri.readTextFile(`${dir}/.novel2vn/${f}`);
        const parsed = JSON.parse(text) as {
          characters?: { id: string; name: string }[];
          items?: { id: string; name: string }[];
        };
        if (parsed && Array.isArray(parsed.characters)) {
          return { characters: parsed.characters, items: Array.isArray(parsed.items) ? parsed.items : [] };
        }
      } catch {
        /* 换下一个 */
      }
    }
    const cached = input.getResult()?.cards;
    return cached ? { characters: cached.characters, items: cached.items ?? [] } : null;
  }

  /** B30：刷新并发令牌。多次 refresh 重叠时（配置/卡片变化与生成结束几乎同时触发），
   *  旧的一次可能晚于新的一次完成，用过期结果覆盖新状态；令牌变化即丢弃本次写入。 */
  let refreshToken = 0;

  async function refresh(): Promise<void> {
    const token = ++refreshToken;
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
      } else if (!rest.includes("_t") && picked.get(n)?.legacy !== false) {
        // 旧版无指纹：只在这一章没有指纹匹配结果时才兜底保留（字典序最新）。
        // 必须加这道守卫：排序用的是 localeCompare，`..._t14bgja8.json` 排在 `....json` 之前，
        // 否则旧缓存会在循环后面把刚匹配上的新剧本覆盖掉 —— 界面退化成「剧本·旧缓存」，
        // 并用过期场景 id 算出整章的假缺失（用户报告的 76/91 就是这么来的）。
        picked.set(n, { pos: n, path: e.path, legacy: true });
      }
      // 失配的新格式文件＝过期残留，直接忽略（下次跑剧本阶段自动清理）
    }
    legacyCount = [...picked.values()].filter((x) => x.legacy).length;
    if (token !== refreshToken) return;
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
    const cardsInfo = await loadCards(dir);
    const characters = cardsInfo?.characters ?? [];
    const items = cardsInfo?.items ?? [];
    // activeConfig("tts") 永远返回一个对象（可能只是没填 Key 的默认配置），
    // 用 apiKey 判定"是否真的能配音"，否则未配置时每章也显示「配音0/N」。
    const ttsCfg = input.getTtsConfig();
    const ttsUsable = !!ttsCfg?.apiKey;
    const imageAvailable = input.getImageAvailable();

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
          // 图像覆盖率：只算本章自己的图（本章背景/CG ＋ 本章出场角色/物品），
          // 与「生成本章」的实际范围一致。旧实现把全书角色的三视图/立绘/动作都算进每一章，
          // 导致每章都是同一个大数字（如 76/91），看不出本章缺什么，还漏掉了物品。
          // 关闭「图像」或未配置图像 API 时不统计（章节完成只看剧本）——否则图永远生不出来，
          // 章节永远"未完成"，「顺序补全未完成」反复空转。
          if (options.useImage === false || !imageAvailable) {
            light.imageTotal = 0;
            light.imageDone = 0;
          } else {
            try {
              const tasks = chapterScopeImageTasks(script, { title: "", characters, scenes: [], items } as never, options);
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
          }
          // 配音覆盖率：未配置 TTS（无 API Key）则跳过显示
          if (ttsUsable && characters.length) {
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
      if (token !== refreshToken) return;
      lights[ch.index] = light;
    }
    // 下线章节清灯
    if (token !== refreshToken) return;
    for (const k of Object.keys(lights).map(Number)) {
      if (!enabled.some((c) => c.index === k)) delete lights[k];
    }
  }

  return { lights, legacy, refresh };
}
