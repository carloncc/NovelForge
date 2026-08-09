import { buildImageTasks } from "../src/core/images";
import { demoExtract } from "../src/core/extract";
import { demoScriptAll } from "../src/core/script";
import { splitChapters } from "../src/core/chapters";
import { DEMO_NOVEL } from "../src/core/demoNovel";

const chapters = splitChapters(DEMO_NOVEL, "星陨之城的守夜人");
const cards = demoExtract(DEMO_NOVEL, "星陨之城的守夜人");
const scripts = demoScriptAll(chapters, cards);

function byKind(tasks: { kind: string }[]): Record<string, number> {
  const m = new Map<string, number>();
  for (const t of tasks) m.set(t.kind, (m.get(t.kind) || 0) + 1);
  return Object.fromEntries(m);
}

// 表情差分开启：每角色 5 张立绘 + 1 张三视图 + 动作 + 1 张风格锚点
const tasksOn = buildImageTasks(scripts, cards, { figurePerCharacter: 1, cgPerChapter: 3, maxPerChapter: 12, figureEmotions: true });
const kindsOn = byKind(tasksOn);
console.log("表情差分开启:", kindsOn);
if ((kindsOn.figure || 0) !== cards.characters.length * 5) throw new Error("表情差分立绘任务数不符");
if ((kindsOn.threeview || 0) !== cards.characters.length) throw new Error("三视图任务数不符");
if ((kindsOn.anchor || 0) !== 1) throw new Error("风格锚点任务数应为 1");
const actionsTotal = cards.characters.reduce((n, c) => n + (c.actions?.length ?? 0), 0);
if ((kindsOn.action || 0) !== actionsTotal) throw new Error("动作任务数不符");

// 表情差分关闭：每角色 1 张（三视图/动作不受影响）
const tasksOff = buildImageTasks(scripts, cards, { figurePerCharacter: 1, cgPerChapter: 3, maxPerChapter: 12, figureEmotions: false });
const kindsOff = byKind(tasksOff);
console.log("表情差分关闭:", kindsOff);
if ((kindsOff.figure || 0) !== cards.characters.length) throw new Error("普通立绘任务数不符");

// 关闭风格锚点：无 anchor 任务，且背景/CG prompt 不含画风锚定提示
const tasksNoAnchor = buildImageTasks(scripts, cards, { styleAnchor: false });
if ((byKind(tasksNoAnchor).anchor || 0) !== 0) throw new Error("styleAnchor:false 不应有锚点任务");
const bgNoAnchor = tasksNoAnchor.find((t) => t.kind === "background");
if (!bgNoAnchor) throw new Error("缺少背景任务");
if (bgNoAnchor.prompt.includes("same exact art style")) throw new Error("关闭锚点时背景不应带画风锚定提示");
const bgAnchor = tasksOn.find((t) => t.kind === "background")!;
if (!bgAnchor.prompt.includes("same exact art style")) throw new Error("开启锚点时背景应带画风锚定提示");
const figAnchor = tasksOn.find((t) => t.kind === "figure" && t.emotion === "normal")!;
if (figAnchor.prompt.includes("same exact art style")) throw new Error("立绘不应使用背景的画风锚定提示");

// 固定种子：指定 baseSeed 时每个任务分配唯一稳定种子，锚点取 baseSeed 本身
const tasksSeeded = buildImageTasks(scripts, cards, { baseSeed: 12345 });
const seeds = tasksSeeded.map((t) => t.seed);
if (seeds.some((s) => s === undefined)) throw new Error("baseSeed 已指定但存在无种子任务");
if (new Set(seeds).size !== seeds.length) throw new Error("种子应有唯一性");
const anchorSeed = tasksSeeded.find((t) => t.kind === "anchor")!.seed;
if (anchorSeed !== 12345) throw new Error("锚点应使用 baseSeed 本身作为种子");
const sorted = seeds.slice().sort((a, b) => a! - b!);
if (sorted.some((s, i) => i > 0 && s! - sorted[i - 1]! !== 1)) throw new Error("种子应按任务顺序连续递增");

// 图生图参考链：默认立绘引用三视图，表情引用默认立绘
const emoTask = tasksOn.find((t) => t.kind === "figure" && t.emotion === "happy")!;
if (!emoTask || emoTask.refFromTask !== "linche") throw new Error("表情任务缺少参考图引用");
const normalTask = tasksOn.find((t) => t.kind === "figure" && t.emotion === "normal")!;
if (normalTask.refFromTask !== "linche_threeview") throw new Error("normal 任务应引用三视图");
const actionTask = tasksOn.find((t) => t.kind === "action" && t.id === "linche_act_draw")!;
if (!actionTask || actionTask.refFromTask !== "linche_threeview") throw new Error("动作任务应引用三视图");

// 三视图基于角色参考图生成：有参考图 → 三视图任务带 referenceImage 并追加一致性提示
{
  const cardsWithRef: any = {
    characters: [
      { ...cards.characters[0], referenceImage: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" },
    ],
    items: cards.items,
    scenes: cards.scenes,
  };
  const tv = buildImageTasks(scripts, cardsWithRef, {}).find((t) => t.kind === "threeview" && t.id === "linche_threeview")!;
  if (!tv || tv.references?.[0]?.role !== "identity") throw new Error("有参考图时三视图应使用 identity 引用");
  if (!tv.prompt.includes("based on the reference image")) throw new Error("有参考图时三视图 prompt 应带一致性提示");
  const tvNoRef = buildImageTasks(scripts, cards, {}).find((t) => t.kind === "threeview")!;
  if (tvNoRef.references?.length) throw new Error("无参考图时三视图不应带引用");
  console.log("  ✓ 三视图可基于角色参考图生成");
}

// 立绘/物品 prompt 强制纯色背景（透明立绘抠图前提）
{
    const check = (c: boolean, m: string) => { if (!c) throw new Error(m); };
  const tasks = buildImageTasks([], { characters: [{ id: "hero", name: "主角", imagePrompt: "anime girl" }], items: [{ id: "sword", name: "剑", imagePrompt: "a sword" }] }, {});
  const figure = tasks.find((t) => t.kind === "figure");
  const item = tasks.find((t) => t.kind === "item");
  const bg = tasks.find((t) => t.kind === "background");
  // 不再强制纯绿背景（保留自然背景）；确认 figure/item 有立绘一致性提示、bg/cg 为场景画风
  check(!figure!.prompt.includes("green chroma background"), "立绘 prompt 不应强制纯绿背景（保留自然背景）");
  check(!item!.prompt.includes("green chroma background"), "物品 prompt 不应强制纯绿背景（保留自然背景）");
  check(figure!.prompt.includes("reference"), "立绘 prompt 应含参考图一致性提示");
  console.log("  ✓ 立绘/物品保留自然背景，不再强制绿幕");
}
console.log("=== 图像任务构建验证通过 ===");
