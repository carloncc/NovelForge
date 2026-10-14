/**
 * 素材管线修复包（2026-10-13 核查报告）的回归测试。
 *
 * 覆盖 7 条缺陷，每条都对应一类**真实会花钱或静默丢产物**的故障：
 *   ① 单张重生成漏传负面词 → 元数据 negativePrompt 落成 null → 下次主管线判「参数不符」
 *      把这张已付费的图再画一次（反复付费重画）；
 *   ② 保存卡片删了图却不摘 assets.json 映射 → 判定只看映射，看板仍绿灯、缺图数算成 0；
 *   ③ 昼夜/天气正则缺 `i` → "Night"/"Dusk"/"Rain"/"Snow" 全落 unspecified/clear，
 *      同地点昼夜不同/天气不同共用一张背景（复用反而串图）；
 *   ④ 表情用量统计用 sanitizeId、卡片侧却是英文归一化 id → 剧本写中文表情时该差分永不出图；
 *   ⑤ 使用集合被当白名单 → 卡片后来新增的表情/服装/动作永远不出图；
 *   ⑥ 单张素材落盘无体积上限 → 超规格响应被登记为"成品"并全链路搬运；
 *   ⑦ Agent 路径动作/服装 id 不归一化 → 两个中文 id 在文件名层消毒成同一个文件互相覆盖。
 *
 * 口径：断言只钉「修复后必须成立的行为」，不放宽任何既有断言（tests/unit-image-usage.ts 中
 * 「统计过但剧本没用 → 只留 normal」的省图口径保持不变，见 ⑤ 的说明）。
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiConfig, ChapterScript, CharacterCard, ExtractionResult, GenerationOptions, ImageTask } from "../src/core/types";
import {
  DEFAULT_NEGATIVE,
  MAX_IMAGE_B64_BYTES,
  assertImageSizeWithinLimit,
  backgroundTimeOfDay,
  backgroundWeather,
  buildImageTasks,
  figureActionEntries,
  figureCostumeEntries,
  figureEmotionEntries,
  runImageTask,
} from "../src/core/images";
import { regenerateImages } from "../src/core/regenerate";
import { saveEditedCards } from "../src/core/cards";
import { collectCharacterImageUsage } from "../src/core/imageUsage";
import { imageTaskHasAsset, statusImageTasks } from "../src/core/stageCascade";
import { mergeCharacter } from "../src/core/extractAgent";
import { normalizeEntityId } from "../src/core/ids";
import { parseAssetMap } from "../src/core/assetMap";
import { sanitizeId } from "../src/core/render";
import { tauri } from "../src/utils/tauri";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function eq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
}

/** 最小合法 PNG：文件头 + IHDR 宽高，供缓存尺寸校验解析 */
function pngB64(width = 1024, height = 1024): string {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString("base64");
}

async function tempRoot(tag: string): Promise<string> {
  return (await mkdtemp(join(tmpdir(), `novelforge-fix-media-${tag}-`))).replace(/\\/g, "/");
}

/** 硅基流动 Qwen 图像配置：走 data[].b64_json 响应，且不支持编辑端点（走普通生成路径） */
function qwenConfig(): ApiConfig {
  return {
    id: "qwen",
    name: "Qwen Image Edit",
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "test",
    model: "Qwen/Qwen-Image-Edit-2509",
    extra: { provider: "siliconflow", protocol: "siliconflow-image" },
  };
}

/** 桩住 HTTP：每次图像请求记数，返回一张带 PNG 文件头的假图 */
function stubImageHttp(payload = pngB64()): { count: () => number; restore: () => void } {
  const original = tauri.http;
  let count = 0;
  tauri.http = async () => {
    count++;
    return {
      status: 200,
      bodyBase64: Buffer.from(JSON.stringify({ data: [{ b64_json: payload }] })).toString("base64"),
      contentType: "application/json",
      headers: {},
    };
  };
  return { count: () => count, restore: () => { tauri.http = original; } };
}

function card(over: Partial<CharacterCard> = {}): CharacterCard {
  return {
    id: "alice",
    name: "爱丽丝",
    appearance: "银发少女",
    clothing: "校服",
    personality: "开朗",
    voiceDesc: "少女音",
    imagePrompt: "alice, silver hair",
    color: "#9ca3af",
    emotions: ["happy", "sad", "angry"],
    costumes: [
      { id: "bikini", name: "泳装", prompt: "bikini" },
      { id: "yukata", name: "浴衣", prompt: "yukata" },
    ],
    actions: [
      { id: "stand", name: "站立", prompt: "standing" },
      { id: "walk", name: "走路", prompt: "walking" },
    ],
    ...over,
  };
}

const cardsOf = (...list: CharacterCard[]): ExtractionResult => ({ title: "t", characters: list, scenes: [], items: [] });

const chapterOf = (index: number, scenes: ChapterScript["scenes"]): ChapterScript =>
  ({ chapter: index, title: `第${index + 1}章`, scenes } as ChapterScript);

const chapterWithLine = (characterId = "alice"): ChapterScript =>
  chapterOf(0, [{
    id: "s1",
    location: "教室",
    time: "白天",
    atmosphere: "平静",
    bgPrompt: "empty classroom, no people",
    figures: [characterId],
    lines: [{ type: "dialogue", text: "…", characterId }],
    itemEvents: [],
    choices: [],
  } as never]);

const generationOptions = (): GenerationOptions => ({ imageBudgetPerChapter: 0, cgPerChapter: 0 } as GenerationOptions);

/* ==================== ① 单张重生成必须带上与主管线逐字相同的负面词 ==================== */
async function testRegenerateWritesExactNegativePrompt(): Promise<void> {
  const root = await tempRoot("negative");
  const cacheRoot = `${root}/.novel2vn/cache`;
  await mkdir(`${cacheRoot}/images`, { recursive: true });
  // 表情差分以默认立绘为参考图：缺失会被显式判 REFERENCE_MISSING（#1509），故预置底图
  await tauri.writeFileBase64(`${cacheRoot}/images/figure_alice_normal.png`, pngB64());

  const cfg = qwenConfig();
  const cards = cardsOf(card({ emotions: ["happy"] }));
  const http = stubImageHttp();
  let results: Awaited<ReturnType<typeof regenerateImages>>;
  try {
    results = await regenerateImages({
      cfg,
      chapters: [],
      cards,
      materials: [],
      outputDir: root,
      log: () => {},
      figureEmotions: true,
      threeView: false,
      actions: false,
      styleAnchor: false,
    }, (task) => task.kind === "figure" && task.id === "alice_happy");
  } finally {
    http.restore();
  }
  eq(results.length, 1, "应重新生成 1 张表情差分");

  // 期望元数据 = 主管线口径：imageMetaForTask(task, cfg, effectiveNegative(task, DEFAULT_NEGATIVE))
  const task = results[0].task;
  eq(task.kind, "figure", "任务应为立绘类");
  const expectedNegative = [DEFAULT_NEGATIVE, "half body, half-body, portrait crop, bust shot, waist-up composition, close-up, cropped head, cropped legs, cropped feet, out of frame, zoomed-in framing"].join(", ");
  const metaPath = `${results[0].path}.meta.json`;
  const meta = JSON.parse((await tauri.readTextFile(metaPath)).text) as Record<string, unknown>;
  eq(meta.negativePrompt, expectedNegative, "meta.json 的 negativePrompt 必须与主管线期望值逐字相等（漏传会落成 null → 下次判参数不符重画）");
  eq(meta.adapter, cfg.adapter ?? null, "adapter 应与配置一致");
  eq(meta.model, cfg.model ?? null, "model 应与配置一致");
  eq(meta.seed, typeof task.seed === "number" ? task.seed : null, "seed 应与任务一致");
  eq(meta.width, task.width, "width 应与任务一致");
  eq(meta.height, task.height, "height 应与任务一致");
  eq(meta.v, 1, "元数据版本应为 1（imageMetaMatches 按 v 判定是否可比）");

  // 端到端：同一任务**不强制**重跑一次 → 必须命中缓存（不再付费），这正是修复前会失败的场景
  const http2 = stubImageHttp();
  let reused: string | null = null;
  try {
    reused = await runImageTask(cfg, task, cacheRoot, () => {}, { outputDir: root });
  } finally {
    http2.restore();
  }
  eq(http2.count(), 0, "负面词一致时不得再发一次付费请求");
  eq(reused, results[0].path, "应复用同一张缓存图");

  // 对照：调用方显式传负面词时仍以调用方为准（默认值不是"覆盖"，只是"缺省"）
  eq(DEFAULT_NEGATIVE.length > 0 && !DEFAULT_NEGATIVE.includes("half body"), true, "DEFAULT_NEGATIVE 是全局负面词，不含人物构图负面词");
  await tauri.removePath(root).catch(() => {});
}

/* ==================== ② 删图必须同步摘 assets.json 映射，缺失数随之增加 ==================== */
async function testCardSaveRemovesAssetMapping(): Promise<void> {
  const root = await tempRoot("assetmap");
  const metaDir = `${root}/.novel2vn`;
  await mkdir(`${metaDir}/cache/images`, { recursive: true });

  const hero = card({ id: "hero", name: "主角" });
  const side = card({ id: "side", name: "配角", emotions: ["happy"], costumes: [], actions: [] });
  const oldCards = cardsOf(hero, side);
  const newCards = cardsOf(side);
  // 旧卡片必须真的落盘：saveEditedCards 的差分（谁被删了 / 哪个字段改了）只从 cards.json 读旧值，
  // 读不到时会退化成"首存"分支（把当前卡片全部当死角色清理），与真实保存路径不符。
  await tauri.writeTextFile(`${metaDir}/cards.json`, JSON.stringify(oldCards, null, 2));

  // 磁盘上的产物（文件名与映射键**不同名**：服装多一个 _normal，三视图前缀不同）
  const files = [
    "figure_hero_normal.png",
    "figure_hero_happy.png",
    "figure_hero_ct_bikini_normal.png",
    "figure_hero_act_stand.png",
    "threeview_hero.png",
    "figure_side_normal.png",
  ];
  for (const f of files) await tauri.writeFileBase64(`${metaDir}/cache/images/${f}`, pngB64());
  // 映射键 = 任务 id（buildImageTasks 的口径）
  const figureMap: Record<string, string> = {
    hero: `${metaDir}/cache/images/figure_hero_normal.png`,
    hero_happy: `${metaDir}/cache/images/figure_hero_happy.png`,
    hero_ct_bikini: `${metaDir}/cache/images/figure_hero_ct_bikini_normal.png`,
    hero_act_stand: `${metaDir}/cache/images/figure_hero_act_stand.png`,
    hero_threeview: `${metaDir}/cache/images/threeview_hero.png`,
    side: `${metaDir}/cache/images/figure_side_normal.png`,
  };
  await tauri.writeTextFile(`${metaDir}/assets.json`, JSON.stringify({ bg: {}, cg: {}, figure: figureMap, item: {}, vocal: {}, shot: {} }, null, 2));

  const chapters = [chapterWithLine("side")];
  const beforeMap = parseAssetMap({ bg: {}, cg: {}, figure: figureMap, item: {}, vocal: {}, shot: {} });
  const before = statusImageTasks(chapters, oldCards, generationOptions());

  const result = await saveEditedCards(root, newCards, () => {});
  eq(result.imageCacheCleared, 5, "hero 的 5 张图应被删除（默认立绘/表情/服装/动作/三视图）");
  for (const f of files.slice(0, 5)) {
    eq(await tauri.pathExists(`${metaDir}/cache/images/${f}`).catch(() => false), false, `${f} 应已删除`);
  }
  eq(await tauri.pathExists(`${metaDir}/cache/images/figure_side_normal.png`).catch(() => false), true, "存活角色的图不得被删");

  const after = parseAssetMap(JSON.parse((await tauri.readTextFile(`${metaDir}/assets.json`)).text));
  for (const key of ["hero", "hero_happy", "hero_ct_bikini", "hero_act_stand", "hero_threeview"]) {
    assert(!(key in after.figure), `映射键 ${key} 必须随文件一起摘除（否则看板仍绿灯、缺图数算成 0）`);
  }
  eq(after.figure.side, figureMap.side, "存活角色的映射必须保留");

  // 缺失数 = 新增的 5 张 hero 图（判定只看映射，正是本条缺陷的观测面）。
  // 只在**同一份任务清单**上比（删角色前后任务数不同：hero 的 9 个任务整个消失，
  // 直接比总缺失数会得到负数），故固定用删除前的任务清单。
  const heroTasks = before.filter((t) => t.characterId === "hero");
  const missingHero = (map: ReturnType<typeof parseAssetMap>): number => heroTasks.filter((t) => !imageTaskHasAsset(t, map)).length;
  eq(heroTasks.length, 9, "hero 应有 9 个图像任务（三视图 + 默认立绘 + 3 表情 + 2 服装 + 2 动作）");
  eq(heroTasks.filter((t) => imageTaskHasAsset(t, beforeMap)).length, 5, "其中 5 张已登记产物");
  eq(missingHero(beforeMap), 4, "修复前 hero 缺 4 张");
  eq(missingHero(after), 9, `映射摘除后 5 张重新计入缺失（实际 ${missingHero(after)}）`);
  eq(missingHero(after) - missingHero(beforeMap), 5, "删除 N 张后缺失数应增加 N");
  // 对照：映射未摘时缺失数一个都不涨（修复前的行为）——这正是看板绿灯假象的成因
  const staleMap = parseAssetMap({ bg: {}, cg: {}, figure: figureMap, item: {}, vocal: {}, shot: {} });
  eq(missingHero(staleMap), 4, "对照：映射未摘时缺失数不涨（看板继续绿灯）");
  await tauri.removePath(root).catch(() => {});
}

/* ==================== ③ 昼夜/天气：大小写与「入夜前」 ==================== */
function testTimeOfDayBuckets(): void {
  const tod = (time: string, atmosphere = "", bgPrompt = ""): string =>
    backgroundTimeOfDay({ id: "x", location: "L", time, atmosphere, bgPrompt });
  const wx = (time: string, bgPrompt = ""): string =>
    backgroundWeather({ id: "x", location: "L", time, bgPrompt });

  // 大小写（LLM 生成的 bgPrompt 首字母大写极常见，旧实现无 i 标志 → 全部落 unspecified）
  eq(tod("", "", "Anime-style apartment at Night"), "night", "大写 Night 必须判 night");
  eq(tod("", "", "NIGHT street with no one"), "night", "全大写 NIGHT 必须判 night");
  eq(tod("", "", "school rooftop at Dusk"), "dusk", "大写 Dusk 必须判 dusk");
  eq(tod("", "", "Morning light through the window"), "morning", "大写 Morning 必须判 morning");
  eq(tod("", "", "Bright Afternoon classroom"), "day", "大写 Afternoon 必须判 day");
  // 补词
  eq(tod("nightfall"), "night", "nightfall 必须判 night");
  eq(tod("", "", "the room lit only by city lights"), "night", "city lights 是夜间线索");
  eq(tod("", "", "under the streetlight"), "night", "streetlight 是夜间线索");
  eq(tod("", "", "warm lamplight on the desk"), "night", "lamplight 是夜间线索");
  eq(tod("清晨出发"), "morning", "清晨→morning（既有断言）");
  eq(tod("破晓时分"), "morning", "破晓→morning");
  // 「入夜前」语义是**天还没黑**（黄昏），旧实现裸匹配「入夜」判成 night → 黄昏与深夜共用一张图
  eq(tod("入夜前"), "dusk", "入夜前→dusk（不是 night）");
  eq(tod("入夜之前"), "dusk", "入夜之前→dusk（不是 night）");
  eq(tod("入夜"), "night", "裸「入夜」仍是 night");
  eq(tod("深夜"), "night", "深夜→night（既有断言）");
  eq(tod("夏夜深夜"), "night", "夏夜深夜→night（既有断言）");
  eq(tod("同日傍晚"), "dusk", "傍晚→dusk（既有断言）");
  eq(tod("夏日午后"), "day", "午后→day（既有断言）");
  eq(tod("初春白天"), "day", "白天→day（既有断言）");
  // 不许把纯日期/季节判成时段（既有断言必须继续通过）
  eq(tod("3月3日"), "unspecified", "纯日期不得猜成白天");
  eq(tod("冬末初春"), "unspecified", "季节不是昼夜");
  // 保守词表：「dim」这类也能形容白天室内的形容词不入表（宁可 unspecified，也不把白天误判成夜里）
  eq(tod("", "", "a dim classroom in the afternoon"), "day", "dim 不入夜间词表，午后仍是 day");

  // 天气：大小写 + 派生词（`\brain\b` 匹配不到 rainy，必须显式列出）
  eq(wx("", "Rainy schoolyard"), "rain", "大写 Rainy 必须判 rain");
  eq(wx("", "SNOW falling"), "snow", "全大写 SNOW 必须判 snow");
  eq(wx("", "snowy schoolyard in winter"), "snow", "snowy→snow（既有断言）");
  eq(wx("雨天放学后"), "rain", "雨→rain（既有断言）");
  eq(wx("冬末初春"), "clear", "冬/初春是季节，不得当成雪天");
  eq(wx("3月3日"), "clear", "无天气线索→clear");

  // 桶键层面：昼夜不同 / 天气不同不得同桶（复用能省钱的前提）
  const base = { id: "s1", location: "satoru_apartment" };
  const night = { ...base, bgPrompt: "apartment at Night" };
  const nightfall = { ...base, bgPrompt: "apartment at nightfall" };
  const rainy = { ...base, bgPrompt: "apartment at Night in the Rain" };
  eq(
    backgroundTimeOfDay(night),
    backgroundTimeOfDay(nightfall),
    "Night 与 nightfall 必须归同一昼夜桶（否则同一场景被画两次）",
  );
  assert(backgroundWeather(night) !== backgroundWeather(rainy), "雨与晴不得同桶");
}

/* ==================== ④ 用量统计与卡片归一化口径一致 ==================== */
function testUsageNormalization(): void {
  const ch = chapterOf(0, [{
    id: "s1",
    location: "教室",
    time: "白天",
    atmosphere: "平静",
    bgPrompt: "classroom",
    figures: ["alice"],
    lines: [
      { type: "dialogue", text: "…", characterId: "alice", emotion: "微笑" },
      { type: "dialogue", text: "…", characterId: "alice", emotion: "happy" },
      { type: "dialogue", text: "…", characterId: "alice", action: "拔剑" },
      { type: "dialogue", text: "…", characterId: "alice", costume: "校服" },
    ],
    itemEvents: [],
    choices: [],
  } as never]);

  // 卡片侧是提取阶段归一化后的 id（emotions.ts / extract.ts 的口径）：
  // 「拔剑」→ normalizeEntityId("拔剑","a")，与 extract.ts 存进卡片的值逐字相同。
  const actionId = normalizeEntityId("拔剑", "a");
  const costumeId = normalizeEntityId("校服", "ct");
  const normalized = card({ emotions: ["happy"], costumes: [{ id: costumeId, name: "校服", prompt: "uniform" }], actions: [{ id: actionId, name: "拔剑", prompt: "draw sword" }] });
  const u = collectCharacterImageUsage([ch], cardsOf(normalized)).get("alice")!;
  assert(u.emotions.includes("happy"), `剧本写中文「微笑」必须统计到卡片的 "happy"（实际 ${u.emotions.join(",")}）`);
  assert(u.actions.includes(actionId), `剧本写中文「拔剑」必须统计到归一化后的动作 id（实际 ${u.actions.join(",")}，期望含 ${actionId}）`);
  assert(u.costumes.includes(costumeId), `剧本写中文「校服」必须统计到归一化后的服装 id（实际 ${u.costumes.join(",")}，期望含 ${costumeId}）`);

  // 同一表情用两种写法写两次 → 只算一个 id（不会把用量虚高到两种形态上）
  const both = chapterOf(0, [{
    id: "s1", location: "L", time: "", atmosphere: "", bgPrompt: "", figures: ["alice"],
    lines: [
      { type: "dialogue", text: "…", characterId: "alice", emotion: "微笑" },
      { type: "dialogue", text: "…", characterId: "alice", emotion: "happy" },
    ],
    itemEvents: [], choices: [],
  } as never]);
  const u2 = collectCharacterImageUsage([both], cardsOf(card({ emotions: ["happy"] }))).get("alice")!;
  eq(u2.emotions.join(","), "happy", "中文与英文写法应归到同一个卡片 id");

  // 存量项目：卡片里还存着原始中文 id 时，旧口径（sanitizeId 形态）必须继续可用，否则使用集合整体变空
  const legacy = card({ emotions: ["微笑"], costumes: [{ id: "校服", name: "校服", prompt: "uniform" }], actions: [{ id: "拔剑", name: "拔剑", prompt: "draw sword" }] });
  const u3 = collectCharacterImageUsage([ch], cardsOf(legacy)).get("alice")!;
  assert(u3.emotions.includes("微笑"), `存量卡片（原始中文表情 id）不得丢统计（实际 ${u3.emotions.join(",")}）`);
  assert(u3.actions.includes("拔剑"), `存量卡片（原始中文动作 id）不得丢统计（实际 ${u3.actions.join(",")}）`);
  assert(u3.costumes.includes("校服"), `存量卡片（原始中文服装 id）不得丢统计（实际 ${u3.costumes.join(",")}）`);
}

/* ==================== ⑤ 使用集合是排序提示，不是白名单 ==================== */
function testUsageIsPriorityNotWhitelist(): void {
  // 卡片后来新增了 sad/angry（imageUsage 还是上次统计的 ["happy"]）→ 必须一起出图，否则永远不构建
  const grown = card({ imageUsage: { emotions: ["happy"], costumes: ["bikini"], actions: ["stand"], chapters: 1 } });
  eq(
    figureEmotionEntries(grown, { figureEmotions: true, detail: "full" }).map((e) => e.id).join(","),
    "normal,happy,sad,angry",
    "使用集合在前、卡片新增的接在后面（否则用户补的表情永远不出图）",
  );
  eq(
    figureCostumeEntries(grown, { detail: "full", threeView: true }).map((c) => c.id).join(","),
    "bikini,yukata",
    "服装同理：剧情真穿过的在前，卡片新增的接在后面",
  );
  eq(
    figureActionEntries(grown, { actions: true, threeView: true }).map((a) => a.id).join(","),
    "stand,walk",
    "动作同理",
  );

  // 档位预算仍是硬上限：次要角色 1 套服装 / 1 个动作，补进来的不会让张数失控
  const npc = card({ isNpc: true, imageUsage: { emotions: ["happy"], costumes: ["bikini"], actions: ["stand"], chapters: 1 } });
  eq(figureCostumeEntries(npc, { detail: "full", threeView: true }).length, 1, "次要角色服装仍限 1 套");
  eq(figureActionEntries(npc, { actions: true, threeView: true }).length, 1, "次要角色动作仍限 1 个");
  eq(figureEmotionEntries(npc, { figureEmotions: true, detail: "full" }).length, 4, "次要角色表情受 5 张预算约束（normal + happy + sad + angry）");

  // 省图口径不变：使用集合为**空** = 剧本确认一次没用 → 不追加卡片全量（见 imageUsage.usageIsKnown）
  const confirmedUnused = card({ imageUsage: { emotions: [], costumes: [], actions: [], chapters: 1 } });
  eq(
    figureEmotionEntries(confirmedUnused, { figureEmotions: true, detail: "full" }).map((e) => e.id).join(","),
    "normal",
    "「统计过且剧本没用」仍只留 normal（不能因为本修复把 #1576 省下的图全放回来）",
  );
  eq(figureCostumeEntries(confirmedUnused, { detail: "full", threeView: true }).length, 0, "确认没换装 → 0 张服装");
  eq(figureActionEntries(confirmedUnused, { actions: true, threeView: true }).length, 0, "确认没动作 → 0 张动作");

  // 无记录（旧项目 / 只跑了提取）仍回退卡片全量 + 卡面前 2 个动作
  const bare = card();
  eq(figureEmotionEntries(bare, { figureEmotions: true, detail: "full" }).length, 4, "无记录时回退整卡表情 + normal");
  eq(figureActionEntries(bare, { actions: true, threeView: true }).length, 2, "无记录时沿用卡面前 2 个动作");
}

/* ==================== ⑥ 单张素材体积闸门 ==================== */
async function testImageSizeGate(): Promise<void> {
  // 纯函数：上限内的通过、超限的抛出
  assertImageSizeWithinLimit("A".repeat(1024), { id: "small" });
  assertImageSizeWithinLimit("A".repeat(MAX_IMAGE_B64_BYTES), { id: "exactly-limit" });
  let threw = "";
  try {
    assertImageSizeWithinLimit("A".repeat(MAX_IMAGE_B64_BYTES + 1), { id: "big", usage: "立绘-测试" });
  } catch (e) {
    threw = String((e as Error).message);
  }
  assert(threw.includes("图片数据过大"), `超限必须抛出且文案命中永久错误分类器，实际：${threw}`);
  assert(threw.includes("立绘-测试"), `错误文案应带上用途便于定位，实际：${threw}`);
  // 量级对齐抠图入口的 32MB 上限（1024²/1536×1024 的正常产物是 1~4MB，不会被误伤）
  eq(MAX_IMAGE_B64_BYTES, 32 * 1024 * 1024, "单张上限应与抠图入口的 CUTOUT_MAX_INPUT_B64_BYTES 同量级");

  // 端到端：超限响应记为**失败项**，且磁盘上没有该文件
  const root = await tempRoot("size");
  const cacheRoot = `${root}/.novel2vn/cache`;
  await mkdir(`${cacheRoot}/images`, { recursive: true });
  const task: ImageTask = {
    kind: "item", id: "sword", prompt: "a sword", fileName: "item_sword.png", width: 1024, height: 1024, usage: "物品-剑",
  };
  const http = stubImageHttp(pngB64());
  let failed = "";
  try {
    // 上限压到 1 字节 = 等价于「厂商返回了超规格响应」，不必真的构造 32MB 载荷
    await runImageTask(qwenConfig(), task, cacheRoot, () => {}, { outputDir: root, force: true, maxImageBytes: 1 });
  } catch (e) {
    failed = String((e as Error).message);
  } finally {
    http.restore();
  }
  assert(failed.includes("图片数据过大"), `超限必须记为失败项，实际错误：${failed}`);
  eq(http.count(), 1, "超限只发一次请求（体积问题重试多少次都一样，不该再烧付费调用）");
  eq(await tauri.pathExists(`${cacheRoot}/images/item_sword.png`).catch(() => false), false, "超限的图不得落盘");
  // 上限内正常落盘（闸门不误伤合法产物）
  const http2 = stubImageHttp(pngB64());
  try {
    await runImageTask(qwenConfig(), task, cacheRoot, () => {}, { outputDir: root, force: true });
  } finally {
    http2.restore();
  }
  eq(await tauri.pathExists(`${cacheRoot}/images/item_sword.png`).catch(() => false), true, "上限内的图应正常落盘");
  await tauri.removePath(root).catch(() => {});
}

/* ==================== ⑦ Agent 路径动作/服装 id 归一化 ==================== */
function testAgentEntityIdNormalization(): void {
  const target = card({ id: "c_x", actions: [], costumes: [], emotions: [] });
  const source = card({
    id: "c_x",
    actions: [
      { id: "拔剑", name: "拔剑", prompt: "draw sword" },
      { id: "挥手", name: "挥手", prompt: "wave hand" },
    ],
    costumes: [
      { id: "校服", name: "校服", prompt: "school uniform" },
      { id: "礼服", name: "礼服", prompt: "dress" },
    ],
  });
  mergeCharacter(target, source);

  const ids = (target.actions ?? []).map((a) => a.id);
  eq(ids.length, 2, "两个不同中文动作 id 合并后仍是两项");
  assert(new Set(ids).size === 2, `两个中文动作 id 归一化后必须互不相同（实际 ${ids.join(",")}）`);
  for (const id of ids) {
    eq(sanitizeId(id), id, `动作 id 必须已是文件名安全形态，否则消毒后互相覆盖：${id}`);
  }
  eq(ids[0], ids[0].toLowerCase(), "动作 id 应为小写形态");
  assert(ids.every((id) => id.startsWith("a_")), `中文动作 id 应归一化为 a_<hash>，实际 ${ids.join(",")}`);

  const costumeIds = (target.costumes ?? []).map((c) => c.id);
  assert(new Set(costumeIds).size === 2, `两个中文服装 id 归一化后必须互不相同（实际 ${costumeIds.join(",")}）`);
  for (const id of costumeIds) eq(sanitizeId(id), id, `服装 id 必须已是文件名安全形态：${id}`);
  assert(costumeIds.every((id) => id.startsWith("ct_")), `中文服装 id 应归一化为 ct_<hash>，实际 ${costumeIds.join(",")}`);

  // 同一中文 id 在两次合并中必须得到**同一个**归一化 id（否则同一动作会被当成两个，反复计费）
  const again = card({ id: "c_x", actions: [], costumes: [], emotions: [] });
  mergeCharacter(again, card({ id: "c_x", actions: [{ id: "拔剑", name: "拔剑", prompt: "draw sword" }], costumes: [], emotions: [] }));
  mergeCharacter(again, card({ id: "c_x", actions: [{ id: "拔剑", name: "拔剑", prompt: "draw sword" }], costumes: [], emotions: [] }));
  eq((again.actions ?? []).length, 1, "同一中文动作重复合并必须去重为一项");
  eq((again.actions ?? [])[0].id, ids[0], "归一化必须跨合并稳定（同一输入同一 id）");

  // 已归一化的 ASCII id 保持不变（既有项目零影响）
  const ascii = card({ id: "c_y", actions: [], costumes: [], emotions: [] });
  mergeCharacter(ascii, card({ id: "c_y", actions: [{ id: "wave", name: "Wave", prompt: "wave" }], costumes: [], emotions: [] }));
  eq((ascii.actions ?? [])[0].id, "wave", "ASCII id 必须原样保留（不改变既有文件名）");

  // 通过 buildImageTasks 观测文件名层：两个动作不得生成同一个文件名
  // （动作差分必须开三视图：figureActionEntries 在 threeView=false 时整体返回空）
  const tasks = buildImageTasks([chapterWithLine("c_x")], cardsOf(target), { styleAnchor: false, threeView: true, actions: true });
  const actionFiles = tasks.filter((t) => t.kind === "action").map((t) => t.fileName);
  eq(actionFiles.length, 2, "两个动作应建两个任务");
  eq(new Set(actionFiles).size, 2, `两个动作的文件名必须不同（实际 ${actionFiles.join(",")}）`);
}

async function main(): Promise<void> {
  await testRegenerateWritesExactNegativePrompt();
  await testCardSaveRemovesAssetMapping();
  testTimeOfDayBuckets();
  testUsageNormalization();
  testUsageIsPriorityNotWhitelist();
  await testImageSizeGate();
  testAgentEntityIdNormalization();
  console.log("=== 素材管线修复包测试通过（负面词/映射摘除/昼夜天气/用量口径/使用集合/体积闸门/id 归一化）===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
