/**
 * 回归测试：核心管线「缓存指纹 / 键口径 / 骨架小说 / 失败项 fail-closed / 关闭前落盘」修复合集。
 *
 * 每条都对应一个真实付费或静默丢数据的缺陷，断言写的是**修复后的行为**（不是复现旧 bug）：
 *  ① assembleProject 覆写 cards.json 丢掉 _novelFp → 每次运行整本重新提取（LLM 付费）+ 重画立绘（图像付费）
 *  ② 停用章剪枝保留集与映射键口径不一致 → 停用再启用后缺背景/无配音
 *  ③ 骨架小说的占位正文能被当成真原文进入生成（并在占位文本上烧一整套付费调用）
 *  ④ 章节重编号/去重只在内存 → chapter-keys.json 映射读写与换算
 *  ⑥ failed.json 损坏静默清空 → 历史失败项无声消失
 *  ⑦ 保存防抖无关闭前 flush → 关窗前 800ms 内的改动丢失
 *  ⑧ 导出游戏忽略系统「减少动态效果」设置
 */
import { splitChapters } from "../src/core/chapters";
import {
  Pipeline,
  buildPruneKeepChapters,
  alignDisabledScriptToKeys,
  pruneAssetRefs,
  setCardsNovelFp,
} from "../src/core/pipeline";
import {
  readChapterKeys,
  writeChapterKeys,
  applyChapterKeySceneIds,
  chapterSceneIdsFor,
  chapterPositionFor,
  isSkeletonNovel,
  emptyChapterKeys,
  scriptCacheFileName,
  scriptFingerprint,
  cardsFingerprint,
} from "../src/core/cache";
import { mutateFailedTasks, readFailedTasks } from "../src/core/failedTasks";
import { restoreProjectState } from "../src/utils/persist";
import { buildThemeCss } from "../src/core/project";
import { tauri } from "../src/utils/tauri";
import type { ChapterScript, ExtractionResult, NovelDoc, PipelineEvent } from "../src/core/types";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const TEMPLATE_DIR = `${import.meta.dirname.replace(/\\/g, "/")}/../src-tauri/templates/webgal`;
const NOVEL_TEXT = "第一章 初见\n林澈:你好;\n第二章 再见\n苏晚晴:再见;";

function demoNovel(): NovelDoc {
  return {
    fileName: "指纹回归.txt",
    sourcePath: "",
    encoding: "UTF-8",
    fullText: NOVEL_TEXT,
    chapters: splitChapters(NOVEL_TEXT, "指纹回归"),
  };
}

function runPipeline(
  out: string,
  stages: string[],
  log: (ev: PipelineEvent) => void,
  novel: NovelDoc = demoNovel(),
  llm?: { apiKey?: string },
): Promise<{ meta: unknown }> {
  const pipeline = new Pipeline({
    novel,
    materials: [],
    outputDir: out,
    templateDir: TEMPLATE_DIR,
    stages: stages as never,
    ...(llm ? { llm: llm as never } : {}),
    options: {
      useImage: false,
      useTts: false,
      useVideoPoints: false,
      useBgm: false,
      figureEmotions: false,
      figureActions: false,
      characterPoses: false,
      imageSelfCheck: false,
      imageBudgetPerChapter: 6,
      cgPerChapter: 2,
      skipCache: false,
      videoPointsPerChapter: 0,
      characterIntroCard: false,
    },
    log,
  });
  return pipeline.run() as Promise<{ meta: unknown }>;
}

async function readJson<T>(path: string): Promise<T> {
  const { text } = await tauri.readTextFile(path);
  return JSON.parse(text) as T;
}

/* ==================== ① 卡片指纹必须活过组装阶段 ==================== */

async function testCardsFingerprintSurvivesAssemble(): Promise<void> {
  const OUT = `${(await mkdtemp(join(tmpdir(), "novelforge-fp-"))).replace(/\\/g, "/")}/game`;
  await tauri.removePath(OUT).catch(() => {});

  // 第一次：提取 + 组装（demo 模式：未配置文本 LLM，走内置演示卡片）
  const logs1: PipelineEvent[] = [];
  await runPipeline(OUT, ["extract", "assemble"], (e) => logs1.push(e));
  const cardsFile = `${OUT}/.novel2vn/cards_demo.json`;
  assert(await tauri.pathExists(cardsFile), "demo 模式卡片缓存应落在 cards_demo.json");
  const first = await readJson<ExtractionResult & { _novelFp?: string }>(cardsFile);
  assert(!!first._novelFp, "提取后卡片缓存必须带 _novelFp 指纹");

  // 组装必须写**当前模式**的文件：demo 组装不得把演示卡片写进正式工作副本 cards.json
  assert(!(await tauri.pathExists(`${OUT}/.novel2vn/cards.json`)), "demo 模式组装不得创建/覆写 cards.json（跨模式污染）");

  // 第二次：提取 + 组装。旧实现在这里必然打印「检测到小说内容变化…正在重新提取」，
  // 因为组装用内存 cards（无 _novelFp）整份覆写了卡片文件。
  const logs2: PipelineEvent[] = [];
  await runPipeline(OUT, ["extract", "assemble"], (e) => logs2.push(e));
  assert(
    !logs2.some((l) => l.message.includes("检测到小说内容变化")),
    "第二次运行不得判「小说内容变化」（否则整本重新提取 + 重画立绘，付费且每轮重复）",
  );
  assert(logs2.some((l) => l.message.includes("[缓存] 复用角色/场景/物品卡")), "第二次运行应复用卡片缓存");
  assert(!logs2.some((l) => l.message.includes("提取完成")), "第二次运行不得重新提取");
  const second = await readJson<ExtractionResult & { _novelFp?: string }>(cardsFile);
  assert(second._novelFp === first._novelFp, `组装后指纹必须与第一次一致（${first._novelFp} → ${second._novelFp}）`);

  // 内存对象也必须带上指纹（所有写盘路径都从这里取，包括组装）
  const mem = setCardsNovelFp({ characters: [], scenes: [], items: [] } as unknown as ExtractionResult, "src:abc");
  assert((mem as { _novelFp?: string })._novelFp === "src:abc", "setCardsNovelFp 必须把指纹写进内存对象");
  assert(
    (setCardsNovelFp({} as object, undefined) as { _novelFp?: string })._novelFp === undefined,
    "无指纹时不得写入 undefined 字段",
  );

  // 已有正式 cards.json 时，demo 组装也不得动它（含其指纹）
  await tauri.writeTextFile(`${OUT}/.novel2vn/cards.json`, JSON.stringify({ characters: [], scenes: [], items: [], _novelFp: "real:keep" }));
  await runPipeline(OUT, ["extract", "assemble"], () => {});
  const real = await readJson<{ _novelFp?: string }>(`${OUT}/.novel2vn/cards.json`);
  assert(real._novelFp === "real:keep", "demo 模式组装不得覆写正式 cards.json（其指纹必须原样保留）");

  await tauri.removePath(OUT).catch(() => {});
  console.log("  ✓ ① 卡片指纹活过组装（第二次运行不再重新提取）");
}

/**
 * ① 的**正式模式**回归（用户明确要求的一条）：
 * 正式模式（配置了文本 API）下 cards.json 才是工作副本，也是组装覆写的那一份。
 *
 * 这里不发起任何网络请求：预置一份带 _novelFp 的正式 cards.json 与一章剧本缓存，
 * 然后以「配置了文本 API」的姿态只跑组装（组装是纯本地渲染），断言覆写后指纹仍在。
 * 旧实现（组装无条件 `JSON.stringify(input.cards)`，而内存 cards 没有指纹字段）
 * 在这条断言上必然失败——它正是"每次运行都整本重新提取（付费）"的成因。
 */
async function testFormalModeFingerprintSurvivesAssemble(): Promise<void> {
  const OUT = `${(await mkdtemp(join(tmpdir(), "novelforge-fpreal-"))).replace(/\\/g, "/")}/game`;
  await tauri.removePath(OUT).catch(() => {});
  const fakeLlm = { apiKey: "unit-test-key-never-used" };
  await tauri.mkdirAll(`${OUT}/.novel2vn/cache`);
  const FP = "novel.txt:fp-formal-1";
  await tauri.writeTextFile(
    `${OUT}/.novel2vn/cards.json`,
    JSON.stringify({
      title: "指纹回归",
      characters: [{ id: "a", name: "林澈", imagePrompt: "lin" }],
      scenes: [{ id: "s1", location: "教室" }],
      items: [],
      _novelFp: FP,
    }),
  );
  const ch1 = {
    chapter: 0,
    title: "第一章 初见",
    scenes: [{ ...scene("s1"), bgPrompt: "教室" }],
  };
  // 剧本缓存文件名与管线同一公式（用 cache.ts 的唯一实现算，避免测试自己拼字符串漂移）
  const cardsForFp = { characters: [{ id: "a", name: "林澈" }], scenes: [{ id: "s1", location: "教室" }], items: [] };
  const styleFrag = scriptFingerprint({ cardsFp: cardsFingerprint(cardsForFp) });
  const ch1Text = "林澈:你好;";
  const ch1File = scriptCacheFileName(`${OUT}/.novel2vn/cache`, false, 0, ch1.title, ch1Text, styleFrag);
  await tauri.writeTextFile(ch1File, JSON.stringify(ch1));

  await runPipeline(OUT, ["assemble"], () => {}, demoNovel(), fakeLlm);
  const after = await readJson<ExtractionResult & { _novelFp?: string }>(`${OUT}/.novel2vn/cards.json`);
  assert(
    after._novelFp === FP,
    `正式模式：组装覆写 cards.json 后 _novelFp 必须原样保留（期望 ${FP}，实际 ${String(after._novelFp)}）`,
  );
  assert(after.characters.length === 1 && after.characters[0].id === "a", "组装写回的卡片内容应与内存一致");
  assert(!(await tauri.pathExists(`${OUT}/.novel2vn/cards_demo.json`)), "正式模式不得写演示卡片文件");

  // 再跑一次组装（模拟下一轮运行读到同一份缓存）→ 指纹必须逐字不变
  await runPipeline(OUT, ["assemble"], () => {}, demoNovel(), fakeLlm);
  const again = await readJson<ExtractionResult & { _novelFp?: string }>(`${OUT}/.novel2vn/cards.json`);
  assert(again._novelFp === FP, "连续两次组装的 _novelFp 必须一致（否则每轮都判「小说内容变化」）");

  await tauri.removePath(OUT).catch(() => {});
  console.log("  ✓ ① 正式模式 cards.json 的 _novelFp 活过组装（连续两次一致）");
}

/* ==================== ② 停用章剪枝保留集与映射键同口径 ==================== */

function scene(id: string, cgEvent = false): ChapterScript["scenes"][number] {
  return {
    id,
    location: `地点-${id}`,
    atmosphere: "",
    time: "",
    // bgPrompt 是 parseChapterScript 的必填字段（缺了整章会被判损坏丢弃），夹具必须给全
    bgPrompt: "",
    figures: [],
    lines: [{ type: "dialogue", characterId: "a", text: "台词" }],
    choices: [],
    itemEvents: [],
    ...(cgEvent ? { cgEvent: { title: `CG-${id}`, prompt: "cg", imagePrompt: "" } } : {}),
  } as unknown as ChapterScript["scenes"][number];
}

function chapter(index: number, ids: string[]): ChapterScript {
  return { chapter: index, title: `第${index + 1}章`, scenes: ids.map((id) => scene(id)) } as unknown as ChapterScript;
}

function testPruneKeepSetMatchesMappingKeys(): void {
  // 两章共享场景卡「教室」→ 产出侧去重后第 5 章是 s3_2，而磁盘缓存里仍是 s3。
  const keys = { posByIndex: { "0": 0, "4": 4 }, sceneIdsByIndex: { "0": ["s3"], "4": ["s3_2"] } };
  const enabled = [chapter(0, ["s3"])]; // 启用章（已重编号 + 已去重）
  const disabled = [chapter(4, ["s3"])]; // 停用章（磁盘口径：novel index 4 + 去重前 id）

  // 旧行为：不传映射 → 保留集只有 s3，s3_2 被当过期删掉
  const legacy = { bg: { s3: "a.png", s3_2: "b.png" }, cg: {}, vocal: {} };
  pruneAssetRefs(legacy, buildPruneKeepChapters(enabled, disabled));
  assert(legacy.bg.s3_2 === undefined, "不传映射时应复现旧行为（s3_2 被误删）——说明该用例确实在测这条");

  // 修复后：保留集按映射换算成 s3_2，映射必须完整保留
  const fixed = { bg: { s3: "a.png", s3_2: "b.png", stale: "c.png" }, cg: {}, vocal: { ch4_s3_2_0: "v.mp3" } };
  pruneAssetRefs(fixed, buildPruneKeepChapters(enabled, disabled, keys));
  assert(fixed.bg.s3 === "a.png", "启用章背景必须保留");
  assert(fixed.bg.s3_2 === "b.png", "停用章的真实产出键 s3_2 必须保留（旧实现会删）");
  assert(fixed.vocal.ch4_s3_2_0 === "v.mp3", "停用章配音键必须保留");
  assert(fixed.bg.stale === undefined, "真正过期的映射仍应清理");

  // 对齐函数：chapter 换成位置、scene.id 按顺序换（数量不符时不动 scene）
  const aligned = alignDisabledScriptToKeys(chapter(4, ["s3"]), keys);
  assert(aligned.chapter === 4 && aligned.scenes[0].id === "s3_2", "停用章剧本应对齐到产出键");
  const mismatched = alignDisabledScriptToKeys(chapter(4, ["s3", "s9"]), keys);
  assert(mismatched.scenes.length === 2 && mismatched.scenes[0].id === "s3", "场景数不符时不得错位改写");

  console.log("  ✓ ② 停用章剪枝保留集与映射键同口径");
}

/* ==================== ④⑨ chapter-keys.json 读写与换算 ==================== */

async function testChapterKeysRoundTrip(): Promise<void> {
  const DIR = `${(await mkdtemp(join(tmpdir(), "novelforge-ck-"))).replace(/\\/g, "/")}`;
  assert((await readChapterKeys(DIR)) === null, "无 chapter-keys.json 时应返回 null（调用方退化成旧行为）");

  const keys = {
    ...emptyChapterKeys(),
    novelFp: "src:fp1",
    posByIndex: { "0": 0, "4": 1 },
    sceneIdsByIndex: { "0": ["s3"], "4": ["s3_2"] },
    vocalKeysByPos: { "1": ["ch1_s3_2_0"] },
    at: "2026-10-13T00:00:00.000Z",
  };
  await writeChapterKeys(DIR, keys);
  const back = await readChapterKeys(DIR);
  assert(!!back && back.novelFp === "src:fp1", "chapter-keys.json 应能原样读回");
  assert(chapterSceneIdsFor(back, 4)?.[0] === "s3_2", "应按 novel index 取到去重后的 scene.id");
  assert(chapterPositionFor(back, 4) === 1, "应按 novel index 取到位置");
  assert(chapterPositionFor(back, 9) === undefined, "无映射的章返回 undefined（调用方回退原值）");

  // 换算：按顺序替换，不改入参；数量不符整章放弃
  const src = chapter(4, ["s3"]);
  const fixed = applyChapterKeySceneIds(src, ["s3_2"]);
  assert(fixed.scenes[0].id === "s3_2", "applyChapterKeySceneIds 应把 scene.id 换成产出键");
  assert(src.scenes[0].id === "s3", "applyChapterKeySceneIds 不得改入参");
  assert(applyChapterKeySceneIds(src, ["s3_2", "s9"]) === src, "数量不符时必须整章放弃改写");
  assert(applyChapterKeySceneIds(src, undefined) === src, "无映射时原样返回");

  // 损坏文件：不抛错，返回 null（界面灯具退化成旧行为，不整块失败）
  await tauri.writeTextFile(`${DIR}/.novel2vn/chapter-keys.json`, "{broken");
  assert((await readChapterKeys(DIR)) === null, "损坏的 chapter-keys.json 应返回 null 而不是抛错");

  await tauri.removePath(DIR).catch(() => {});
  console.log("  ✓ ④⑨ chapter-keys.json 落盘/读取/换算");
}

/* ==================== ③ 骨架小说必须被拦截 ==================== */

async function testSkeletonNovelBlocked(): Promise<void> {
  const DIR = `${(await mkdtemp(join(tmpdir(), "novelforge-sk-"))).replace(/\\/g, "/")}`;
  await tauri.mkdirAll(`${DIR}/.novel2vn/cache`);
  // 只有剧本缓存、没有 split.json、没有源文件 → 骨架分支
  await tauri.writeTextFile(
    `${DIR}/.novel2vn/cache/script_ch1_abc_t123.json`,
    JSON.stringify({ chapter: 0, title: "第 1 章", scenes: [] }),
  );
  const restored = await restoreProjectState(DIR);
  assert(!!restored.novel, "有剧本缓存时应重建出章节骨架（保持「可继续按章操作」的能力）");
  assert(isSkeletonNovel(restored.novel), "骨架小说必须带显式标记");
  assert(
    restored.warnings.some((w) => w.includes("占位") || w.includes("重新导入小说")),
    `骨架分支必须给出明确 warning（当前：${JSON.stringify(restored.warnings)}）`,
  );
  assert(
    (restored.novel!.chapters[0].text || "").includes("分章缓存缺失"),
    "骨架章节正文确实是占位串（本用例的前提）",
  );

  // 占位正文绝不能进入生成：管线入口必须直接抛错，且不得写出任何产物
  let threw = "";
  try {
    await runPipeline(DIR, ["split", "extract", "script"], () => {}, restored.novel!);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assert(threw.includes("重新导入小说"), `骨架小说跑管线必须抛「请重新导入小说」（实际：${threw || "未抛错"}）`);
  assert(!(await tauri.pathExists(`${DIR}/.novel2vn/split.json`)), "被拦截时不得写出 split.json（它是原文最后一处副本）");

  await tauri.removePath(DIR).catch(() => {});
  console.log("  ✓ ③ 骨架小说被标记 + 生成入口拦截");
}

/* ==================== ⑥ failed.json 损坏必须 fail-closed ==================== */

async function testFailedTasksFailClosed(): Promise<void> {
  const DIR = `${(await mkdtemp(join(tmpdir(), "novelforge-ft-"))).replace(/\\/g, "/")}`;
  await tauri.mkdirAll(`${DIR}/.novel2vn`);
  const file = `${DIR}/.novel2vn/failed.json`;
  const corrupt = '[{"id":"bg_1","step":"图像","message":"背景失败"';
  await tauri.writeTextFile(file, corrupt);

  let threw = false;
  try {
    await mutateFailedTasks(DIR, (prev) => [...prev, { id: "new", kind: "image", step: "图像", message: "背景：新失败", at: 1 }]);
  } catch {
    threw = true;
  }
  assert(threw, "损坏的 failed.json 必须让本次写入失败（不得以空基底整份覆写）");
  const still = (await tauri.readTextFile(file)).text;
  assert(still === corrupt, "损坏文件必须原样保留（唯一副本不能被覆盖）");
  const backups = (await readdir(`${DIR}/.novel2vn`)).filter((n) => n.startsWith("failed.json.corrupt-"));
  assert(backups.length === 1, `必须留下 .corrupt-<ts> 备份（实际 ${JSON.stringify(backups)}）`);

  // 正常路径不受影响：文件不存在 → 空表；结构合法 → 正常读改写
  const DIR2 = `${DIR}-ok`;
  await tauri.mkdirAll(`${DIR2}/.novel2vn`);
  assert((await readFailedTasks(DIR2)).length === 0, "文件不存在应返回空表（首次运行是合法状态）");
  await mutateFailedTasks(DIR2, () => [{ id: "a", kind: "image", step: "图像", message: "背景：x", at: 1 }]);
  const after = await mutateFailedTasks(DIR2, (prev) => [...prev, { id: "b", kind: "image", step: "图像", message: "背景：y", at: 2 }]);
  assert(after.length === 2, "合法文件必须正常累加（历史条目不得丢）");

  await tauri.removePath(DIR).catch(() => {});
  await tauri.removePath(DIR2).catch(() => {});
  console.log("  ✓ ⑥ failed.json 损坏 fail-closed（原文件保留 + 隔离备份）");
}

/* ==================== ⑦ 关闭前 flush 钩子 ==================== */

async function testCloseFlushHook(): Promise<void> {
  const listeners = new Map<string, ((ev: unknown) => void)[]>();
  const g = globalThis as unknown as { window?: unknown };
  const hadWindow = "window" in g;
  const prevWindow = g.window;
  g.window = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
  };
  try {
    const { registerProjectSaveFlush } = await import("../src/stores/project");
    registerProjectSaveFlush();
    registerProjectSaveFlush(); // 幂等
    assert((listeners.get("pagehide")?.length ?? 0) === 1, "应注册且只注册一次 pagehide 钩子");
    assert((listeners.get("beforeunload")?.length ?? 0) === 1, "应注册 beforeunload 钩子");
  } finally {
    if (hadWindow) g.window = prevWindow;
    else delete (g as { window?: unknown }).window;
  }
  console.log("  ✓ ⑦ 关闭前 flush 钩子已注册（pagehide + beforeunload，幂等）");
}

/* ==================== ⑧ 导出游戏尊重「减少动态效果」 ==================== */

function testReducedMotionCss(): void {
  const css = buildThemeCss("/* base */\n", "测试作品", "zh_CN", null);
  assert(css.includes("@media (prefers-reduced-motion: reduce)"), "主题 CSS 必须包含 reduce-motion 段");
  assert(/prefers-reduced-motion[\s\S]*animation-duration: 0\.001ms/.test(css), "reduce-motion 段应关掉动画时长");
  assert(/prefers-reduced-motion[\s\S]*transition-duration: 0\.001ms/.test(css), "reduce-motion 段应关掉过渡时长");
  assert(!/prefers-reduced-motion[\s\S]*display:\s*none/.test(css), "只去掉运动，不得隐藏元素");
  console.log("  ✓ ⑧ 导出游戏主题 CSS 尊重 prefers-reduced-motion");
}

/* ==================== ④ loadCachedChapters 必须排除段缓存、失败回退候选 ==================== */

function scriptPayload(chapter: number, title: string): string {
  return JSON.stringify({ chapter, title, scenes: [{ ...scene(`s${chapter + 1}`), bgPrompt: "教室" }] });
}

async function testCachedChaptersSkipPartFiles(): Promise<void> {
  const DIR = `${(await mkdtemp(join(tmpdir(), "novelforge-lcc-"))).replace(/\\/g, "/")}`;
  await tauri.mkdirAll(`${DIR}/.novel2vn/cache`);
  // cards.json 必须存在，否则 store 不会去恢复章节列表
  await tauri.writeTextFile(
    `${DIR}/.novel2vn/cards.json`,
    JSON.stringify({ title: "t", characters: [{ id: "a", name: "A" }], scenes: [], items: [] }),
  );
  const whole = `${DIR}/.novel2vn/cache/script_ch5_aaa_t111.json`;
  const part = `${DIR}/.novel2vn/cache/script_ch5_part1of3_zzz_t111.json`;
  await tauri.writeTextFile(whole, scriptPayload(4, "整章剧本"));
  // 段文件名在 localeCompare 下恒胜（part 的 'p' > titleHash 首字符），旧实现只读段文件、
  // 解析失败后整章从 lastResult.chapters 消失（章节列表/重跑勾选/角色出场统计一起少一章）。
  await tauri.writeTextFile(part, JSON.stringify({ version: 1, chapterIndex: 4, part: 1, total: 3, rest: "zzz_t111", model: "m" }));

  // chapters 由 store 的 restoreProject 填充（persist 层只交回 cards/meta），故这里走 store 入口。
  // loadCachedChapters 在 store 内部，测试通过 restoreProject 间接覆盖（与 unit-persist 同法）。
  const g = globalThis as unknown as { window?: unknown };
  const hadWindow = "window" in g;
  const prevWindow = g.window;
  g.window = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
    addEventListener: () => {},
  };
  try {
    const { restoreProject, projectState } = await import("../src/stores/project");
    await restoreProject(DIR);
    const chapters = projectState.lastResult?.chapters ?? [];
    assert(chapters.length === 1, `段缓存必须被排除，只应恢复 1 章（实际 ${chapters.length}）`);
    assert(chapters[0].title === "整章剧本", `应恢复整章剧本而不是段文件（实际 ${chapters[0].title}）`);

    // 首选候选损坏时必须回退下一个候选，而不是整章丢弃：
    // 再加一个字典序更靠后的整章候选（keepNewest 会选它作首选），把它写坏 → 必须回退到 aaa
    const other = `${DIR}/.novel2vn/cache/script_ch5_zzz_t111.json`;
    await tauri.writeTextFile(other, "{broken");
    await restoreProject(DIR);
    const chapters2 = projectState.lastResult?.chapters ?? [];
    assert(chapters2.length === 1, `首选候选损坏时应回退另一候选（实际 ${chapters2.length} 章）`);
    assert(chapters2[0].title === "整章剧本", `回退候选应来自未损坏的整章文件（实际 ${chapters2[0].title}）`);
  } finally {
    if (hadWindow) g.window = prevWindow;
    else delete (g as { window?: unknown }).window;
  }

  await tauri.removePath(DIR).catch(() => {});
  console.log("  ✓ ④ 段缓存被排除 + 候选解析失败回退");
}

async function main(): Promise<void> {
  // ⑦ 必须最先跑：它断言「首次注册」的幂等性，而 restoreProject（④ 用例）会注册一次钩子
  await testCloseFlushHook();
  await testCardsFingerprintSurvivesAssemble();
  await testFormalModeFingerprintSurvivesAssemble();
  testPruneKeepSetMatchesMappingKeys();
  await testChapterKeysRoundTrip();
  await testCachedChaptersSkipPartFiles();
  await testSkeletonNovelBlocked();
  await testFailedTasksFailClosed();
  testReducedMotionCss();
  console.log("=== 管线缓存指纹/键口径修复回归测试通过 ===");
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
