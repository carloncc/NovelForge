/**
 * 图片小说任务通道（#809）：只产出 三视图 + 分镜（+可选物品图），不产立绘/表情/动作/服装；
 * 三个旋钮（每场景/每章/总量）裁剪并保留已生成；文件命名与映射键稳定。
 */
import { buildImageStoryPlan } from "../src/core/imageStory";
import type { ChapterScript, ExtractionResult, ImageStoryOptions } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const cards: ExtractionResult = {
  title: "测试",
  characters: [
    { id: "alice", name: "爱丽丝", appearance: "金发", clothing: "白裙", personality: "活泼", voiceDesc: "", imagePrompt: "anime girl, blonde", color: "#fff" },
    { id: "bob", name: "鲍勃", appearance: "黑发", clothing: "外套", personality: "沉稳", voiceDesc: "", imagePrompt: "anime boy, black hair", color: "#000" },
  ],
  scenes: [],
  items: [{ id: "sword", name: "剑", appearance: "银剑", note: "信物", imagePrompt: "a silver sword" }],
};

function scene(id: string, shots: number, chars?: string[]): ChapterScript["scenes"][number] {
  return {
    id,
    location: "城门",
    atmosphere: "黄昏",
    time: "傍晚",
    bgPrompt: "gate at dusk",
    itemEvents: [],
    figures: [],
    lines: [
      { type: "dialogue", characterId: "alice", text: "第一句" },
      { type: "dialogue", characterId: "bob", text: "第二句" },
      { type: "narration", text: "第三句" },
      { type: "dialogue", characterId: "alice", text: "第四句" },
      { type: "narration", text: "第五句" },
    ],
    shots: Array.from({ length: shots }, (_, i) => ({
      id: `${id}_shot${i + 1}`,
      prompt: `shot ${i + 1} at the gate`,
      triggerLineIndex: i,
      characters: chars ?? (i === 0 ? ["alice"] : ["bob", "ghost"]),
      note: `镜头${i + 1}`,
    })),
  };
}

const chapters: ChapterScript[] = [
  { chapter: 0, title: "第一章", scenes: [scene("s1", 3), scene("s2", 1)] },
  { chapter: 1, title: "第二章", scenes: [scene("s3", 2), scene("s4", 1, ["ghost"])] },
];

const base: ImageStoryOptions = {
  shotsPerScene: 0,
  shotsPerChapter: 0,
  shotsTotal: 0,
  imageStyle: "anime style",
  imageSeed: 0,
  styleAnchor: false,
  includeItems: false,
};

// 1) 默认（全不限）：三视图 ×2 + 分镜 6；不含立绘/表情/动作/服装/物品；含背景锚点关闭
const plan = buildImageStoryPlan(chapters, cards, base);
const kinds = plan.tasks.map((t) => t.kind);
assert(plan.threeviewCount === 2, `三视图应为 2，实际 ${plan.threeviewCount}`);
assert(plan.shotCount === 7, `分镜应为 7，实际 ${plan.shotCount}`);
assert(plan.itemCount === 0, "物品图默认关闭");
assert(!kinds.includes("figure"), "图片小说不得产出立绘任务");
assert(!kinds.includes("action"), "图片小说不得产出动作任务");
assert(!kinds.includes("background"), "图片小说不得产出背景任务");
assert(!kinds.includes("cg"), "图片小说不得产出 CG 任务");

// 2) 分镜任务结构：id/文件名/参考/尺寸/角色过滤
const firstShot = plan.tasks.find((t) => t.kind === "shot" && t.sceneId === "s1" && t.shotIndex === 0)!;
assert(firstShot.id === "s1_shot1", `分镜 id 异常：${firstShot.id}`);
assert(firstShot.fileName === "shot_ch1_s1_1.png", `分镜文件名异常：${firstShot.fileName}`);
assert(firstShot.width === 1536 && firstShot.height === 1024, "分镜应为 1536×1024");
assert(firstShot.refFromTask === "alice_threeview", `分镜应以出场角色三视图为参考：${firstShot.refFromTask}`);
const secondShot = plan.tasks.find((t) => t.kind === "shot" && t.shotIndex === 1 && t.sceneId === "s1")!;
assert(secondShot.refFromTask === "bob_threeview", "多角色时取第一个有效角色（ghost 不在卡片中应被忽略）");
const orphanShot = plan.tasks.find((t) => t.kind === "shot" && t.sceneId === "s4")!;
assert(!orphanShot.refFromTask, "无有效角色时分镜走纯文生图（不带参考）");
assert(firstShot.prompt.startsWith("shot 1 at the gate"), "分镜提示词应来自 shot.prompt");

// 3) 每场景上限：s1 从 3 张裁到 2 张
const perScene = buildImageStoryPlan(chapters, cards, { ...base, shotsPerScene: 2 });
assert(perScene.shotCount === 6, `每场景 2 张时应为 6，实际 ${perScene.shotCount}`);

// 4) 每章上限：第一章裁到 3 张（跨场景累计）
const perChapter = buildImageStoryPlan(chapters, cards, { ...base, shotsPerChapter: 3 });
assert(perChapter.shotCount === 6, `每章 3 张时应为 6，实际 ${perChapter.shotCount}`);

// 5) 总量上限：只取前 2 张（到达上限停止派发，保留已生成）
const perTotal = buildImageStoryPlan(chapters, cards, { ...base, shotsTotal: 2 });
assert(perTotal.shotCount === 2, `总量 2 张时应为 2，实际 ${perTotal.shotCount}`);
assert(perTotal.tasks.filter((t) => t.kind === "threeview").length === 2, "总量上限不应影响三视图（分镜一致性依赖）");

// 6) 物品图开关（#1099）：图片小说渲染与鉴赏室都不展示物品图，开启也不构建（避免静默烧钱）
const withItems = buildImageStoryPlan(chapters, cards, { ...base, includeItems: true });
assert(withItems.itemCount === 0, `图片小说不展示物品图：开启也应为 0，实际 ${withItems.itemCount}`);

// 7) 费用预估 = 任务数 × 单价
assert(Math.abs(plan.estimatedYuan - Math.round(plan.tasks.length * 0.3 * 100) / 100) < 1e-9, "预计费用应为 任务数 × 0.3 元");

console.log("=== image story tasks tests passed ===");
