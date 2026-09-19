/**
 * 立绘全身构图回归：人物类任务必须是全身（head to feet），不得再出现半身（thighs-up）构图词。
 */
import { buildImageTasks } from "../src/core/images";
import type { ExtractionResult } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const cards: ExtractionResult = {
  title: "t",
  scenes: [],
  items: [],
  characters: [
    {
      id: "sakura",
      name: "西园寺樱月",
      gender: "female",
      appearance: "",
      clothing: "",
      personality: "",
      voiceDesc: "",
      imagePrompt: "anime style, a graceful girl with silver hair, full body",
      threeViewPrompt: "anime style, same girl, three views, full body",
      actions: [{ id: "wave", name: "挥手", prompt: "the girl waving one hand, full body" }],
      costumes: [{ id: "casual", name: "日常", prompt: "the girl in casual clothes, full body" }],
      color: "",
    },
  ],
};

const tasks = buildImageTasks([], cards, { cgPerChapter: 0, maxPerChapter: 0 });
const figures = tasks.filter((t) => t.kind === "figure" || t.kind === "action");
const threeviews = tasks.filter((t) => t.kind === "threeview");
assert(figures.length >= 3, `应生成 立绘/表情/服装/动作 任务（实际 ${figures.length}）`);
assert(threeviews.length === 1, "应生成三视图任务");

for (const t of [...figures, ...threeviews]) {
  assert(!/thighs-up/i.test(t.prompt), `${t.id} 不应出现半身（thighs-up）构图词`);
}
for (const t of figures) {
  assert(/full body visible from head to feet including shoes/i.test(t.prompt), `${t.id} 应要求全身且含鞋子`);
  assert(/no half-body framing/i.test(t.prompt), `${t.id} 应显式排除半身构图`);
}
for (const t of threeviews) {
  assert(/full body visible/i.test(t.prompt), `${t.id} 应要求全身`);
}

console.log("=== 立绘全身构图回归测试通过 ===");
