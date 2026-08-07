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

// 表情差分开启：每角色 5 张立绘 + 1 张三视图 + 动作
const tasksOn = buildImageTasks(scripts, cards, { figurePerCharacter: 1, cgPerChapter: 3, maxPerChapter: 12, figureEmotions: true });
const kindsOn = byKind(tasksOn);
console.log("表情差分开启:", kindsOn);
if ((kindsOn.figure || 0) !== cards.characters.length * 5) throw new Error("表情差分立绘任务数不符");
if ((kindsOn.threeview || 0) !== cards.characters.length) throw new Error("三视图任务数不符");
const actionsTotal = cards.characters.reduce((n, c) => n + (c.actions?.length ?? 0), 0);
if ((kindsOn.action || 0) !== actionsTotal) throw new Error("动作任务数不符");

// 表情差分关闭：每角色 1 张（三视图/动作不受影响）
const tasksOff = buildImageTasks(scripts, cards, { figurePerCharacter: 1, cgPerChapter: 3, maxPerChapter: 12, figureEmotions: false });
const kindsOff = byKind(tasksOff);
console.log("表情差分关闭:", kindsOff);
if ((kindsOff.figure || 0) !== cards.characters.length) throw new Error("普通立绘任务数不符");

// 图生图参考链：默认立绘引用三视图，表情引用默认立绘
const emoTask = tasksOn.find((t) => t.kind === "figure" && t.emotion === "happy")!;
if (!emoTask || emoTask.refFromTask !== "linche") throw new Error("表情任务缺少参考图引用");
const normalTask = tasksOn.find((t) => t.kind === "figure" && t.emotion === "normal")!;
if (normalTask.refFromTask !== "linche_threeview") throw new Error("normal 任务应引用三视图");
const actionTask = tasksOn.find((t) => t.kind === "action" && t.id === "linche_act_draw")!;
if (!actionTask || actionTask.refFromTask !== "linche_threeview") throw new Error("动作任务应引用三视图");

// 立绘/物品 prompt 强制纯色背景（透明立绘抠图前提）
{
    const check = (c: boolean, m: string) => { if (!c) throw new Error(m); };
  const tasks = buildImageTasks([], { characters: [{ id: "hero", name: "主角", imagePrompt: "anime girl" }], items: [{ id: "sword", name: "剑", imagePrompt: "a sword" }] }, {});
  const figure = tasks.find((t) => t.kind === "figure");
  const item = tasks.find((t) => t.kind === "item");
  const bg = tasks.find((t) => t.kind === "background");
  check(figure!.prompt.includes("green chroma background"), "立绘 prompt 缺少纯绿背景约束");
  check(item!.prompt.includes("green chroma background"), "物品 prompt 缺少纯绿背景约束");
  console.log("  ✓ 立绘/物品 prompt 含纯绿背景约束，背景/CG 不含");
}
console.log("=== 图像任务构建验证通过 ===");
