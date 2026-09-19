import { chapterCharacterIds, chapterItemIds, chapterScopeImageTasks } from "../src/core/chapterAssets";
import { buildImageTasks } from "../src/core/images";
import { demoExtract } from "../src/core/extract";
import { demoScriptAll } from "../src/core/script";
import { splitChapters } from "../src/core/chapters";
import { DEMO_NOVEL } from "../src/core/demoNovel";
import type { ChapterScript, GenerationOptions, ImageTask } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const options = { useImage: true, useTts: false } as unknown as GenerationOptions;
const chapters = splitChapters(DEMO_NOVEL, "星陨之城的守夜人");
const cards = demoExtract(DEMO_NOVEL, "星陨之城的守夜人");
const scripts = demoScriptAll(chapters, cards);
assert(scripts.length >= 2, `示例小说应切出至少 2 章，实际 ${scripts.length}`);

const FIGURE_KINDS = new Set(["threeview", "figure", "action"]);
const isFigureTask = (t: ImageTask): boolean => FIGURE_KINDS.has(t.kind);

// ① 章节口径 = 本章背景/CG ＋ 本章出场角色的人物图 ＋ 本章引用的物品图，且不含全书画风锚点
for (const script of scripts) {
  const tasks = chapterScopeImageTasks(script, cards, options);
  const sceneIds = new Set(script.scenes.map((s) => s.id));
  const charIds = chapterCharacterIds(script);
  const itemIds = chapterItemIds(script);

  assert(!tasks.some((t) => t.kind === "anchor"), `章节口径不应含全书画风锚点（ch${script.chapter}）`);

  const bg = tasks.filter((t) => t.kind === "background");
  assert(bg.length === script.scenes.length, `本章背景数应为 ${script.scenes.length}，实际 ${bg.length}（ch${script.chapter}）`);
  for (const t of bg) assert(sceneIds.has(t.id), `背景应属于本章场景：${t.id}（ch${script.chapter}）`);

  const cg = tasks.filter((t) => t.kind === "cg");
  const cgScenes = script.scenes.filter((s) => s.cgEvent);
  assert(cg.length === cgScenes.length, `本章 CG 数应为 ${cgScenes.length}，实际 ${cg.length}（ch${script.chapter}）`);

  for (const t of tasks.filter(isFigureTask)) {
    assert(!!t.characterId && charIds.has(t.characterId), `人物图应只给本章出场角色：${t.id}（ch${script.chapter}）`);
  }
  for (const t of tasks.filter((t) => t.kind === "item")) {
    assert(itemIds.has(t.id), `物品图应只给本章引用的物品：${t.id}（ch${script.chapter}）`);
  }
  assert(
    tasks.filter((t) => t.kind === "item").length === itemIds.size,
    `本章物品图数应为 ${itemIds.size}，实际 ${tasks.filter((t) => t.kind === "item").length}（ch${script.chapter}）`,
  );

  // 章节口径必须是「按本章收窄」，不会多于全书口径
  const wholeBook = buildImageTasks([script], cards, {
    cgPerChapter: 0,
    maxPerChapter: 0,
    styleAnchor: false,
  });
  assert(
    tasks.length <= wholeBook.filter((t) => t.kind !== "anchor").length,
    `章节口径不应超过全书口径（ch${script.chapter}：${tasks.length} vs ${wholeBook.length}）`,
  );
}

// ② 回归：各章图像总数必须随本章出场角色/物品变化
//    （旧实现每章都把全书角色的三视图/立绘/动作算进去 → 每章同一个大数字，用户报告的 76/91）
const totals = scripts.map((s) => chapterScopeImageTasks(s, cards, options).length);
assert(
  new Set(totals).size > 1,
  `各章图像总数不应完全相同（旧 bug 每章都算全书人物图），实际 ${JSON.stringify(totals)}`,
);

// ③ 本章物品必须计入（旧实现给 buildImageTasks 传 items: []，物品图永远不出现）
for (const script of scripts) {
  const itemIds = chapterItemIds(script);
  if (!itemIds.size) continue;
  const tasks = chapterScopeImageTasks(script, cards, options);
  assert(
    [...itemIds].every((id) => tasks.some((t) => t.kind === "item" && t.id === id)),
    `本章引用的物品图应全部计入：${[...itemIds].join(",")}（ch${script.chapter}）`,
  );
}

// ④ 没有出场角色的章节不应产生任何人物图任务（但背景仍要算）
const noCharChapter: ChapterScript | undefined = scripts.find((s) => chapterCharacterIds(s).size === 0);
if (noCharChapter) {
  const tasks = chapterScopeImageTasks(noCharChapter, cards, options);
  assert(!tasks.some(isFigureTask), `无出场角色的章节不应有人物图任务（ch${noCharChapter.chapter}）`);
  assert(tasks.some((t) => t.kind === "background"), `无出场角色的章节仍要算背景（ch${noCharChapter.chapter}）`);
}

// ⑤ 关闭三视图/动作开关时不产生对应任务；关闭表情时只留默认立绘
const onlyNormal = { useImage: true, useTts: false, characterPoses: false, figureEmotions: false } as unknown as GenerationOptions;
const sample = scripts[0];
assert(chapterCharacterIds(sample).size > 0, "示例第 1 章应有出场角色");
const plainTasks = chapterScopeImageTasks(sample, cards, onlyNormal);
assert(!plainTasks.some((t) => t.kind === "threeview" || t.kind === "action"), "关闭人物姿态后不应有三视图/动作任务");
assert(
  plainTasks.filter((t) => t.kind === "figure").length === chapterCharacterIds(sample).size,
  "关闭表情差分后每角色只应剩默认立绘 1 张",
);

console.log("=== 章节图像口径（按本章收窄、含物品、不含锚点）测试通过 ===");