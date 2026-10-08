import { buildImageTasks, backgroundBucketKey } from "../src/core/images";
import { demoExtract } from "../src/core/extract";
import { demoScriptAll } from "../src/core/script";
import { splitChapters } from "../src/core/chapters";
import { DEMO_NOVEL } from "../src/core/demoNovel";
import { scriptCacheFileName, scriptCacheRest } from "../src/core/cache";
import { DEFAULT_BACKGROUND_REUSE } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const chapters = splitChapters(DEMO_NOVEL, "星陨之城的守夜人");
const cards = demoExtract(DEMO_NOVEL, "星陨之城的守夜人");
const scripts = demoScriptAll(chapters, cards);
assert(scripts.length >= 2, `示例小说应切出至少 2 章，实际 ${scripts.length}`);

function bgCount(tasks: { kind: string }[]): number {
  return tasks.filter((t) => t.kind === "background").length;
}

/** 场景集合按「地点[×昼夜[×天气]]」分桶后的桶数（与被测实现的独立口径） */
function bucketCount(scenes: { id: string; location?: string; time?: string; atmosphere?: string; bgPrompt?: string }[], mode = DEFAULT_BACKGROUND_REUSE): number {
  return new Set(scenes.map((s) => backgroundBucketKey(s, mode))).size;
}

// 不过滤：背景数＝全书分桶数（#1580 复用：同桶场景共用一张图），而不是场景数
const allScenes = scripts.flatMap((s) => s.scenes);
const all = buildImageTasks(scripts, cards, { cgPerChapter: 0, maxPerChapter: 0 });
const expectAll = bucketCount(allScenes);
assert(bgCount(all) === expectAll, `全量背景数应为分桶数 ${expectAll}，实际 ${bgCount(all)}`);
assert(expectAll < allScenes.length, `示例数据应存在同桶场景（否则本用例失去意义）：${expectAll} vs ${allScenes.length}`);

// 关闭复用＝旧口径：一个场景实例一张（回归保护，确认开关真的能回到旧行为）
const offAll = buildImageTasks(scripts, cards, { cgPerChapter: 0, maxPerChapter: 0, backgroundReuse: "off" });
assert(
  bgCount(offAll) === allScenes.length,
  `关闭背景复用时背景数应等于场景数 ${allScenes.length}，实际 ${bgCount(offAll)}`,
);
assert(
  offAll.filter((t) => t.kind === "background").every((t) => (t.fileName as string).startsWith("bg_") && !t.bgSceneIds),
  "关闭复用时不应带同桶别名（旧行为：一场景一文件）",
);

// 复用任务必须覆盖本范围内的**全部**场景（漏掉会让那些场景退回"沿用上一张背景"）
const covered = new Set(all.filter((t) => t.kind === "background").flatMap((t) => t.bgSceneIds ?? []));
assert(
  covered.size >= new Set(allScenes.map((s) => s.id)).size,
  `复用别名应覆盖全部场景 id：${covered.size} vs ${new Set(allScenes.map((s) => s.id)).size}`,
);

// 单章过滤：只保留目标章背景，全局任务（锚点/三视图/立绘/物品）不受影响
const target = scripts[1];
const scoped = buildImageTasks(scripts, cards, {
  cgPerChapter: 0,
  maxPerChapter: 0,
  chapterIndexes: new Set([target.chapter]),
});
assert(
  bgCount(scoped) === bucketCount(target.scenes),
  `单章背景数应为该章分桶数 ${bucketCount(target.scenes)}，实际 ${bgCount(scoped)}`,
);
const targetSceneIds = new Set(target.scenes.map((s) => s.id));
for (const t of scoped.filter((t) => t.kind === "background")) {
  assert(targetSceneIds.has(t.id), `单章背景任务应属于目标章节场景：${t.id}`);
  for (const sid of t.bgSceneIds ?? []) {
    assert(targetSceneIds.has(sid), `单章背景别名应属于目标章节场景：${sid}（${t.id}）`);
  }
  assert(!!t.bgChapters?.includes(target.chapter), `单章背景任务应记录所属章节：${t.id}`);
}
const kinds = (tasks: { kind: string }[]): Record<string, number> => {
  const m = new Map<string, number>();
  for (const t of tasks) m.set(t.kind, (m.get(t.kind) || 0) + 1);
  return Object.fromEntries(m);
};
const kAll = kinds(all);
const kScoped = kinds(scoped);
for (const k of ["anchor", "threeview", "figure", "item"]) {
  assert((kScoped[k] || 0) === (kAll[k] || 0), `全局任务 ${k} 不应被章节过滤影响`);
}
// CG 同样按章过滤；CG 键只用 scene.id（不含章节号，重编号不再作废）
const cgAll = buildImageTasks(scripts, cards, { cgPerChapter: 3, maxPerChapter: 0 });
const cgScoped = buildImageTasks(scripts, cards, { cgPerChapter: 3, maxPerChapter: 0, chapterIndexes: new Set([target.chapter]) });
const targetCgScenes = new Set(target.scenes.filter((s) => s.cgEvent).map((s) => s.id));
for (const t of cgScoped.filter((t) => t.kind === "cg")) {
  assert(!/^\d+_/.test(t.id), `CG 键不应含章节号前缀：${t.id}`);
  assert(targetCgScenes.has(t.id), `单章 CG 应属于目标章节场景：${t.id}`);
  assert(!(t.fileName as string).match(/^cg_\d+_/), `CG 文件名不应含章节号：${t.fileName}`);
}
assert(
  cgScoped.filter((t) => t.kind === "cg").length <= cgAll.filter((t) => t.kind === "cg").length,
  "单章 CG 数不应超过全量",
);

// 缓存文件名：同输入稳定，不同正文/标题/文风即换键
const f1 = scriptCacheFileName("/c", false, 2, "第三章", "正文ABC", "");
const f2 = scriptCacheFileName("/c", false, 2, "第三章", "正文ABC", "");
assert(f1 === f2, "同输入文件名应稳定");
assert(f1 === "/c/script_ch3_" + scriptCacheRest("第三章", "正文ABC", "") + ".json", `文件名格式异常：${f1}`);
assert(scriptCacheFileName("/c", false, 2, "第三章", "正文XYZ", "") !== f1, "正文变化应换键");
assert(scriptCacheFileName("/c", false, 2, "第三章改", "正文ABC", "") !== f1, "标题变化应换键");
assert(scriptCacheFileName("/c", false, 2, "第三章", "正文ABC", "_stX") !== f1, "文风变化应换键");
assert(scriptCacheFileName("/c", true, 2, "第三章", "正文ABC", "") !== f1, "演示模式前缀应不同");

console.log("=== chapter scope tests passed ===");
