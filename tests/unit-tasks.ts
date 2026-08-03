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

// 表情差分开启：每角色 5 张
const tasksOn = buildImageTasks(scripts, cards, { figurePerCharacter: 1, cgPerChapter: 3, maxPerChapter: 12, figureEmotions: true });
const kindsOn = byKind(tasksOn);
console.log("表情差分开启:", kindsOn);
if ((kindsOn.figure || 0) !== cards.characters.length * 5) throw new Error("表情差分立绘任务数不符");

// 表情差分关闭：每角色 1 张
const tasksOff = buildImageTasks(scripts, cards, { figurePerCharacter: 1, cgPerChapter: 3, maxPerChapter: 12, figureEmotions: false });
const kindsOff = byKind(tasksOff);
console.log("表情差分关闭:", kindsOff);
if ((kindsOff.figure || 0) !== cards.characters.length) throw new Error("普通立绘任务数不符");

// 表情任务引用 normal 做参考图
const emoTask = tasksOn.find((t) => t.kind === "figure" && t.emotion === "happy")!;
if (!emoTask || emoTask.refFromTask !== "linche") throw new Error("表情任务缺少参考图引用");
const normalTask = tasksOn.find((t) => t.kind === "figure" && t.emotion === "normal")!;
if (normalTask.refFromTask) throw new Error("normal 任务不应有参考图引用");

console.log("=== 图像任务构建验证通过 ===");
