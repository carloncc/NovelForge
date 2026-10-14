import { reactive } from "vue";
import type { ApiConfig, ChapterScript, GenerationOptions, NovelDoc, PipelineResult } from "../core/types";
import { chapterScopeImageTasks } from "../core/chapterAssets";
import { buildVoiceJobs } from "../core/voice";
import { scriptCacheRest, scriptFingerprint, titleHash, cardsFingerprint, isScriptPartFileName, readChapterKeys, chapterSceneIdsFor, chapterPositionFor, applyChapterKeySceneIds, type ChapterKeysFile } from "../core/cache";
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
  /**
   * 本章覆盖到的图像任务 id。全局总账靠它**按 id 去重**：
   * 角色三视图/立绘/表情/动作是项目级资产，同一张图会被多个章节同时"覆盖"，
   * 各章灯直接相加会把它重复计入（实测某项目 30 章相加 3566，实际只有 857 张）。
   */
  imageIds: string[];
  /** imageIds 中已生成的子集（同样用于去重统计） */
  imageDoneIds: string[];
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
  imageIds: [],
  imageDoneIds: [],
  voiceDone: 0,
  voiceTotal: 0,
  voiceSkipped: true,
});

/** 单章内容是否完成（队列目标判定口径：剧本＋图像齐了即可，不含配音） */
export function isChapterContentComplete(l: ChapterLight): boolean {
  return l.script && (l.imageTotal === 0 || l.imageDone >= l.imageTotal);
}

interface ChapterStatusInput {
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

  /** 卡片（角色＋物品＋场景）：章节图像口径要按「本章出场角色/物品」收窄，所以物品也要读；
   *  demo/正式隔离（#792）：优先读当前模式对应的文件，避免演示模式按正式卡算任务数。
   *  卡片指纹（id+名称）参与剧本缓存键——卡片变了旧剧本必须失效。 */
  async function loadCards(
    dir: string,
    demo: boolean,
  ): Promise<{ characters: { id: string; name: string }[]; items: { id: string; name: string }[]; scenes: { id: string; location?: string }[] } | null> {
    for (const f of demo ? ["cards_demo.json", "cards.json"] : ["cards.json", "cards_demo.json"]) {
      try {
        const { text } = await tauri.readTextFile(`${dir}/.novel2vn/${f}`);
        const parsed = JSON.parse(text) as {
          characters?: { id: string; name: string }[];
          items?: { id: string; name: string }[];
          scenes?: { id: string; location?: string }[];
        };
        if (parsed && Array.isArray(parsed.characters)) {
          return {
            characters: parsed.characters,
            items: Array.isArray(parsed.items) ? parsed.items : [],
            scenes: Array.isArray(parsed.scenes) ? parsed.scenes : [],
          };
        }
      } catch {
        /* 换下一个 */
      }
    }
    const cached = input.getResult()?.cards;
    return cached
      ? { characters: cached.characters, items: cached.items ?? [], scenes: cached.scenes ?? [] }
      : null;
  }

  /** B30：刷新并发令牌。多次 refresh 重叠时（配置/卡片变化与生成结束几乎同时触发），
   *  旧的一次可能晚于新的一次完成，用过期结果覆盖新状态；令牌变化即丢弃本次写入。 */
  let refreshToken = 0;

  async function refresh(): Promise<void> {
    const token = ++refreshToken;
    const dir = input.getOutputDir();
    const novel = input.getNovel();
    if (!dir || !novel) {
      // 不能直接 return：清灯逻辑在函数末尾，无项目时会留着上一个项目的章节灯，
      // 而 lights 按章节 index 索引，下一个项目重叠的 index 会显示上一个项目的状态。
      for (const k of Object.keys(lights).map(Number)) delete lights[k];
      legacy.count = 0;
      return;
    }
    const options = input.getOptions();
    const enabled = novel.chapters.filter((c) => c.enabled !== false);
    const demo = !input.getLlmAvailable();
    // 卡片先读（卡片指纹要进剧本缓存键；图像口径也要用卡片）
    const cardsInfo = await loadCards(dir, demo);
    if (token !== refreshToken) return;
    const style = (options.scriptStyle ?? "").trim();
    const styleFrag = scriptFingerprint({
      style,
      compressNarration: options.compressNarration,
      cardsFp: cardsInfo ? cardsFingerprint(cardsInfo) : "",
    });
    const cacheDir = `${dir}/.novel2vn/cache`;
    const lang = (options.language ?? "").trim();
    // 章节键映射（novel index → 位置 + 去重后 scene.id）：磁盘剧本缓存里存的是 novel index 与
    // **去重前**的 scene.id，而 assets 映射的键是「重编号 + 跨章去重后」的。不按映射换算，
    // 跨章共享场景卡（两章都有「教室」→ 都输出 s3）时本章会用 s3 去查映射，
    // 命中的是**别章**的背景图 → imageDone >= imageTotal → 判本章"已完成" →
    // 「顺序生成未完成章节」永不补这一章，成片里这一章沿用上一张背景。
    const chapterKeys: ChapterKeysFile | null = await readChapterKeys(dir);
    if (token !== refreshToken) return;

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
      // #1538：显式排除段缓存。pipeline.ts::classifyScriptCache 走的是 isScriptPartFileName 这道显式
      // 拦截，这里原先没有——只是因为段缓存的 rest 里必然含 _t（scriptCacheRest 的 `${hash}_t${hash}`
      // 格式），才被下面的「失配新格式＝stale」顺带忽略掉。两个实现今天结论一致，但机制不同：
      // 哪天为了缩短文件名去掉 _t，界面就会把 script_ch1_partKofT_*.json 当整章剧本选中，
      // 拿半章内容算素材引用，整章报「假缺失」（用户报告 76/91）。这里与管线对齐成同一机制。
      .filter((x) => !x.isDir && !isScriptPartFileName(x.name) && /^script(_demo)?_ch\d+_/.test(x.name))
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
          // 先把磁盘剧本对齐到真实产出键（scene.id 按映射换算；无映射时原样返回）。
          // 章节灯按 novel index 索引，但配音键里的章节号用的是**位置**，故还要 pos。
          script = applyChapterKeySceneIds(script, chapterSceneIdsFor(chapterKeys, ch.index));
          const pos = chapterPositionFor(chapterKeys, ch.index) ?? ch.index;
          // 图像覆盖率：只算本章自己的图（本章背景/CG ＋ 本章出场角色/物品），
          // 与「生成本章」的实际范围一致。旧实现把全书角色的三视图/立绘/动作都算进每一章，
          // 导致每章都是同一个大数字（如 76/91），看不出本章缺什么，还漏掉了物品。
          // 关闭「图像」或未配置图像 API 时不统计（章节完成只看剧本）——否则图永远生不出来，
          // 章节永远"未完成"，「顺序补全未完成」反复空转。
          if (options.useImage === false || !imageAvailable) {
            light.imageTotal = 0;
            light.imageDone = 0;
            light.imageIds = [];
            light.imageDoneIds = [];
          } else {
            try {
              const tasks = chapterScopeImageTasks(script, { title: "", characters, scenes: [], items } as never, options);
              light.imageTotal = tasks.length;
              light.imageIds = tasks.map((t) => t.id);
              light.imageDoneIds = tasks
                .filter((t) => {
                  if (t.kind === "background") return Boolean(assets.bg[t.id]);
                  if (t.kind === "cg") return Boolean(assets.cg[t.id]);
                  if (t.kind === "item") return Boolean(assets.item[t.id]);
                  return Boolean(assets.figure[t.id]);
                })
                .map((t) => t.id);
              light.imageDone = light.imageDoneIds.length;
            } catch {
              /* 任务构建失败则保持 0 */
            }
          }
          // 配音覆盖率：未配置 TTS（无 API Key）则跳过显示
          if (ttsUsable && characters.length) {
            try {
              // 配音键的章节号是**位置**（voice.ts 的 sceneVocalKey(chapter.chapter, …)），
              // 磁盘剧本的 chapter 是 novel index：不换算的话，只要前面有停用章（序号≠index），
              // 本章配音灯恒为 0/N，队列会反复重跑这一章。
              const jobs = buildVoiceJobs(ttsCfg, [{ ...script, chapter: pos }], characters as never);
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
