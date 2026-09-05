import { buildImageTasks } from "../src/core/images";
import { demoExtract } from "../src/core/extract";
import { demoScriptAll } from "../src/core/script";
import { splitChapters } from "../src/core/chapters";
import { DEMO_NOVEL } from "../src/core/demoNovel";
import { scriptCacheFileName, scriptCacheRest } from "../src/core/cache";

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

// 不过滤：背景数＝各章场景数之和
const all = buildImageTasks(scripts, cards, { figurePerCharacter: 1, cgPerChapter: 0, maxPerChapter: 0 });
const expectAll = scripts.reduce((n, s) => n + s.scenes.length, 0);
assert(bgCount(all) === expectAll, `全量背景数应为 ${expectAll}，实际 ${bgCount(all)}`);

// 单章过滤：只保留目标章背景，全局任务（锚点/三视图/立绘/物品）不受影响
const target = scripts[1];
const scoped = buildImageTasks(scripts, cards, {
  figurePerCharacter: 1,
  cgPerChapter: 0,
  maxPerChapter: 0,
  chapterIndexes: new Set([target.chapter]),
});
assert(bgCount(scoped) === target.scenes.length, `单章背景数应为 ${target.scenes.length}，实际 ${bgCount(scoped)}`);
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
const cgAll = buildImageTasks(scripts, cards, { figurePerCharacter: 1, cgPerChapter: 3, maxPerChapter: 0 });
const cgScoped = buildImageTasks(scripts, cards, { figurePerCharacter: 1, cgPerChapter: 3, maxPerChapter: 0, chapterIndexes: new Set([target.chapter]) });
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
