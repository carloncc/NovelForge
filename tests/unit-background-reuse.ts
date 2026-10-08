/**
 * #1580 背景复用：一张背景图服务「地点 × 昼夜 × 天气」相同的**一组**场景。
 *
 * 钉死的不变量（每一条都对应一类真实会花钱的故障）：
 *  ① 桶键/文件名/种子只吃场景自身字段 —— 「先跑单章、后跑全书」必须算出同一个文件名与同一个种子，
 *     否则同一张图被画两次（重复计费），或先画的被后画的覆盖（画风漂移）。
 *  ② 桶内**全部**场景都要在任务里有名字（bgSceneIds）—— 漏掉的场景在渲染端会退回
 *     「沿用上一张背景」（同一个房间白天/夜里串图）。
 *  ③ 非 ASCII 地点不能直接 sanitize —— 每个汉字折叠成一个下划线，
 *     「聪的一室一厅公寓」与「入山聪公寓客厅的灯下桌旁」会撞成同一个文件（#1547 同族）。
 *  ④ off 必须精确回到旧行为（一场景一张、文件名 bg_<sceneId>）——它是逃生舱口。
 *  ⑤ 昼夜/天气判定：中文 time 字段（实测形如「夏夜深夜」「同日傍晚」「3月3日」）必须判对，
 *     且**不能**把「3月3日」当白天、不能把「冬末初春」当雪天。
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundBucketFileName, backgroundBucketKey, backgroundTimeOfDay, backgroundWeather, buildImageTasks, generateImages, selectBackgroundScenes } from "../src/core/images";
import { DEFAULT_BACKGROUND_REUSE } from "../src/core/types";
import type { ChapterScript, ExtractionResult, ImageTask } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function eq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
}

type Scene = {
  id: string;
  location: string;
  time?: string;
  atmosphere?: string;
  bgPrompt?: string;
  figures: never[];
  lines: never[];
  itemEvents: never[];
  choices: never[];
};

function scene(id: string, location: string, extra: Partial<Scene> = {}): Scene {
  return { id, location, figures: [], lines: [], itemEvents: [], choices: [], ...extra };
}

const cards = { title: "T", characters: [], scenes: [], items: [] } as unknown as ExtractionResult;

function chapters(...list: Scene[][]): ChapterScript[] {
  return list.map((scenes, i) => ({ chapter: i, title: `第${i + 1}章`, scenes } as unknown as ChapterScript));
}

function bgTasks(tasks: ImageTask[]): ImageTask[] {
  return tasks.filter((t) => t.kind === "background");
}

/** 最小 PNG（仅文件头，供尺寸校验读取宽高） */
function pngBuffer(w: number, h: number): Buffer {
  const buf = Buffer.alloc(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12);
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

const OPTS = { cgPerChapter: 0, maxPerChapter: 0, styleAnchor: false } as const;

/* ---------- ① 桶键 / 文件名 / 种子的范围无关性 ---------- */
{
  const night = scene("s1", "satoru_apartment", { time: "深夜" });
  const sameNightLater = scene("s99", "satoru_apartment", { time: "深夜，接近凌晨三点" });
  const day = scene("s2", "satoru_apartment", { time: "夏日午后" });
  const rain = scene("s3", "satoru_apartment", { time: "深夜", bgPrompt: "rainy night apartment" });

  eq(backgroundBucketKey(night, "locationTimeWeather"), backgroundBucketKey(sameNightLater, "locationTimeWeather"), "同地点同昼夜同天气应同桶");
  assert(backgroundBucketKey(night, "locationTimeWeather") !== backgroundBucketKey(day, "locationTimeWeather"), "昼夜不同不应同桶");
  assert(backgroundBucketKey(night, "locationTimeWeather") !== backgroundBucketKey(rain, "locationTimeWeather"), "天气不同不应同桶");
  eq(backgroundBucketFileName(night, "locationTimeWeather"), backgroundBucketFileName(sameNightLater, "locationTimeWeather"), "同桶文件名必须一致");
  eq(backgroundBucketFileName(night, "off"), "bg_s1.png", "off 必须保持旧文件名（bg_<sceneId>）");

  // 场景 id 不同（不同章）但同桶 → 任务文件名与种子都必须一致
  const whole = buildImageTasks(chapters([night], [sameNightLater]), cards, { ...OPTS, baseSeed: 7 });
  const onlySecond = buildImageTasks(chapters([sameNightLater]), cards, { ...OPTS, baseSeed: 7 });
  const scopedSecond = buildImageTasks(chapters([night], [sameNightLater]), cards, { ...OPTS, baseSeed: 7, chapterIndexes: new Set([1]) });
  eq(bgTasks(whole).length, 1, "跨章同桶应只建一个背景任务");
  eq(bgTasks(whole)[0].fileName, bgTasks(onlySecond)[0].fileName, "单章构建与整本构建的文件名必须一致");
  eq(bgTasks(whole)[0].seed, bgTasks(onlySecond)[0].seed, "单章构建与整本构建的种子必须一致（否则同一张图重复计费）");
  eq(bgTasks(whole)[0].seed, bgTasks(scopedSecond)[0].seed, "chapterIndexes 构建的种子也必须一致");

  // ② 桶内全部场景都要有名字
  eq((bgTasks(whole)[0].bgSceneIds ?? []).join(","), "s1,s99", "同桶场景应全部登记为别名");
  eq((bgTasks(whole)[0].bgChapters ?? []).join(","), "0,1", "同桶涉及的章节应全部登记（单章强制重画要靠它命中）");
  eq(bgTasks(whole)[0].id, "s1", "代表场景应是故事顺序里的第一个");
}

/* ---------- ③ 非 ASCII 地点不撞车 ---------- */
{
  // 两个字数相同、汉字不同的地点：sanitize 后都是等长下划线，直接拼会撞成同一个文件
  const a = scene("a", "聪的一室一厅公寓", { time: "深夜" });
  const b = scene("b", "入山聪公寓客厅的灯", { time: "深夜" });
  assert(backgroundBucketFileName(a, "locationTimeWeather") !== backgroundBucketFileName(b, "locationTimeWeather"),
    "不同中文地点不得生成同一个文件名");
  const f = backgroundBucketFileName(a, "locationTimeWeather");
  assert(/^bg_[A-Za-z0-9_-]+\.png$/.test(f), `文件名必须是 ASCII 安全形态：${f}`);
  eq(backgroundBucketFileName(a, "locationTimeWeather"), backgroundBucketFileName(scene("zzz", "聪的一室一厅公寓", { time: "深夜" }), "locationTimeWeather"),
    "同一中文地点的文件名必须跨运行稳定（含哈希也稳定）");
  // 纯 ASCII 地点保持可读
  eq(backgroundBucketFileName(scene("x", "satoru_apartment", { time: "深夜" }), "locationTimeWeather"), "bg_satoru_apartment_night_clear.png", "ASCII 地点应保持可读文件名");
}

/* ---------- ④ off 回到旧行为 ---------- */
{
  const chs = chapters([scene("s1", "A", { time: "深夜" }), scene("s2", "A", { time: "深夜" }), scene("s3", "A", { time: "深夜" })]);
  const on = buildImageTasks(chs, cards, OPTS);
  const off = buildImageTasks(chs, cards, { ...OPTS, backgroundReuse: "off" });
  eq(bgTasks(on).length, 1, "复用开启：同地点同昼夜同天气的 3 个场景应合成 1 张");
  eq(bgTasks(off).length, 3, "复用关闭：应回到一场景一张");
  assert(bgTasks(off).every((t) => !t.bgSceneIds), "复用关闭时不应有别名");
  assert(bgTasks(off).every((t) => t.fileName === `bg_${t.id}.png`), "复用关闭时文件名应回到 bg_<sceneId>");

  // location / locationTime 两档的粒度
  const chs2 = chapters([scene("s1", "A", { time: "深夜" }), scene("s2", "A", { time: "夏日午后" })]);
  eq(bgTasks(buildImageTasks(chs2, cards, { ...OPTS, backgroundReuse: "location" })).length, 1, "只按地点：昼夜不同也合成一张");
  eq(bgTasks(buildImageTasks(chs2, cards, { ...OPTS, backgroundReuse: "locationTime" })).length, 2, "地点×昼夜：昼夜不同应各一张");
  eq(bgTasks(buildImageTasks(chs2, cards, OPTS)).length, 2, "默认口径=地点×昼夜×天气");
  eq(DEFAULT_BACKGROUND_REUSE, "locationTimeWeather", "默认口径必须是地点×昼夜×天气");
}

/* ---------- ⑤ 昼夜/天气判定 ---------- */
{
  const tod = (t: string, atmo = "", bg = ""): string => backgroundTimeOfDay(scene("x", "L", { time: t, atmosphere: atmo, bgPrompt: bg }));
  eq(tod("深夜"), "night", "深夜→night");
  eq(tod("夏夜深夜"), "night", "夏夜深夜→night");
  eq(tod("深夜，接近凌晨三点"), "night", "凌晨→night");
  eq(tod("同日傍晚"), "dusk", "傍晚→dusk");
  eq(tod("夏日午后"), "day", "午后→day");
  eq(tod("初春白天"), "day", "白天→day");
  eq(tod("清晨出发"), "morning", "清晨→morning");
  eq(tod("3月3日"), "unspecified", "纯日期不得猜成白天（time 里大量「3月N日」）");
  eq(tod("", "", "Anime-style apartment at night, dim desk lamp"), "night", "bgPrompt 的 night 应生效");
  eq(tod("冬末初春"), "unspecified", "季节不是昼夜");

  const wx = (t: string, bg = ""): string => backgroundWeather(scene("x", "L", { time: t, bgPrompt: bg }));
  eq(wx("雨天放学后"), "rain", "雨→rain");
  eq(wx("", "snowy schoolyard in winter"), "snow", "snow→snow");
  eq(wx("冬末初春"), "clear", "冬/初春是季节，不得当成雪天");
  eq(wx("3月3日"), "clear", "无天气线索→clear");
}

/* ---------- ⑥ 复用开启时「每章同地点上限」必须失效 ---------- */
{
  const ch = { chapter: 0, title: "t", scenes: [scene("s1", "A"), scene("s2", "A"), scene("s3", "A"), scene("s4", "A")] } as unknown as ChapterScript;
  eq(selectBackgroundScenes(ch, 3, "off").scenes.length, 3, "off：每章同地点上限 3 应生效");
  eq(selectBackgroundScenes(ch, 3, "locationTimeWeather").scenes.length, 4, "复用开启：上限失效，返回全部场景（否则被裁的场景没有映射）");
  const tasks = buildImageTasks([ch], cards, { ...OPTS, backgroundsPerLocation: 3 });
  eq(bgTasks(tasks).length, 1, "复用开启：同桶 4 个场景合成 1 张，不受每章同地点上限影响");
}

/* ---------- ⑦ 「每章背景数上限」在复用口径下按新开的桶数计 ---------- */
{
  const ch = { chapter: 0, title: "t", scenes: [scene("s1", "A", { time: "深夜" }), scene("s2", "A", { time: "夏日午后" }), scene("s3", "B", { time: "深夜" })] } as unknown as ChapterScript;
  const capped = buildImageTasks([ch], cards, { cgPerChapter: 0, maxPerChapter: 1, styleAnchor: false });
  eq(bgTasks(capped).length, 1, "每章上限 1 → 本章只开 1 个桶");
  const uncapped = buildImageTasks([ch], cards, OPTS);
  eq(bgTasks(uncapped).length, 3, "不限 → 3 个桶各一张");
}

/* ---------- ⑧ 同桶别名必须真的写进映射（缓存命中与生成两条路径都要） ---------- */
{
  // 渲染端逐场景查 assets.bg[scene.id]：别名漏写 = 桶内其它场景退回"沿用上一张背景"
  // （同一个房间白天/夜里串图），而文件其实已经生成好了——这类漏写只有跑一次真实生成路径才看得见。
  const root = (await mkdtemp(join(tmpdir(), "novelforge-bg-reuse-"))).replace(/\\/g, "/");
  const cacheRoot = `${root}/.novel2vn/cache`;
  await mkdir(`${cacheRoot}/images`, { recursive: true });
  const chs = chapters([scene("s1", "A", { time: "深夜" }), scene("s2", "A", { time: "深夜" })], [scene("s3", "A", { time: "深夜" })]);
  const tasks = buildImageTasks(chs, cards, OPTS);
  const bg = bgTasks(tasks);
  eq(bg.length, 1, "三个同桶场景应只建一个背景任务");
  const target = `${cacheRoot}/images/${bg[0].fileName}`;
  await writeFile(target, pngBuffer(bg[0].width, bg[0].height));

  const r = await generateImages(
    undefined, chs, cards, [], cacheRoot, () => {}, 1,
    false, undefined, undefined, false, false, false,
    undefined, undefined, false,
  );
  eq(r.generated, 0, "全部命中缓存不应计费");
  for (const id of ["s1", "s2", "s3"]) {
    assert(!!r.images.bg[id], `同桶场景 ${id} 必须有背景映射（别名漏写会串图）`);
    eq(r.images.bg[id], target, `同桶场景 ${id} 必须指向同一张图`);
  }
}

console.log("=== 背景复用（#1580：地点×昼夜×天气，同桶共用一张、跨范围口径一致）测试通过 ===");
