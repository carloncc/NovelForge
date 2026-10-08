/**
 * 生成前图片总账（新需求）：按章节灯聚合 共多少张 / 已生成 / 待生成。
 * 口径必须与章节灯一致（已有剧本才可统计；未生成剧本的章节单独计数）。
 *
 * 去重口径（回归）：角色三视图/立绘/表情/动作是**项目级资产**，同一张图会被它出场的
 * 每一章同时计入。各章灯直接相加会让总账虚高 —— 实测某项目 30 章灯相加 3566，
 * 全局唯一任务只有 857（背景 406 · 立绘/表情 321 · 动作 50 · 物品 54 · 三视图 25 · 锚点 1）。
 */
import { missingImagesInChapters, summarizeImagePlan } from "../src/core/imageStats";
import type { ChapterLight } from "../src/composables/useChapterStatus";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function light(partial: Partial<ChapterLight>): ChapterLight {
  return {
    script: false, legacyScript: false,
    imageDone: 0, imageTotal: 0, imageIds: [], imageDoneIds: [],
    voiceDone: 0, voiceTotal: 0, voiceSkipped: true,
    ...partial,
  };
}

const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => prefix + i);

// 1) 已有剧本的章节：总数/已生成/待生成按 id 去重后聚合
const lights: Record<number, ChapterLight | undefined> = {
  0: light({ script: true, imageTotal: 10, imageDone: 4, imageIds: ids("a", 10), imageDoneIds: ids("a", 4) }),
  1: light({ script: true, imageTotal: 5, imageDone: 5, imageIds: ids("b", 5), imageDoneIds: ids("b", 5) }),
  2: light({ script: false, imageTotal: 0, imageDone: 0 }),
  3: light({ script: true, imageTotal: 0, imageDone: 0 }), // 图像关闭/未配置时灯为 0/0，合法
};
const s = summarizeImagePlan(lights, [0, 1, 2, 3]);
assert(s.total === 15, `总数应为 15，实际 ${s.total}`);
assert(s.done === 9, `已生成应为 9，实际 ${s.done}`);
assert(s.missing === 6, `待生成应为 6，实际 ${s.missing}`);
assert(s.knownChapters === 3, `可统计章节应为 3，实际 ${s.knownChapters}`);
assert(s.unknownChapters === 1, `未生成剧本章节应为 1，实际 ${s.unknownChapters}`);

// 2) 空输入不炸
const empty = summarizeImagePlan({}, []);
assert(empty.total === 0 && empty.missing === 0 && empty.knownChapters === 0 && empty.unknownChapters === 0, "空输入应全 0");

// 3) 指定范围只算范围内（逐章批量确认用）
assert(missingImagesInChapters(lights, [0]) === 6, "第 1 章待生成应为 6");
assert(missingImagesInChapters(lights, [1]) === 0, "第 2 章已齐应为 0");
assert(missingImagesInChapters(lights, [2]) === 0, "缺剧本章节不计入");
assert(missingImagesInChapters(lights, [0, 1]) === 6, "多章去重后待生成应为 6");

// 4) 已生成多于总数（换过剧本）时不出现负数
const odd = summarizeImagePlan({ 0: light({ script: true, imageTotal: 3, imageDone: 5, imageIds: ids("c", 3), imageDoneIds: ids("c", 3).concat("ghost") }) }, [0]);
assert(odd.missing === 0, "已生成超过总数时待生成应为 0，不得为负");

// 5) 项目级资产跨章去重 —— 本次修复的成因
//    alice 的三视图/立绘/动作在两章里都出现，只能算一次；背景各章独立，各算一次。
const shared: Record<number, ChapterLight | undefined> = {
  0: light({
    script: true, imageTotal: 4, imageDone: 1,
    imageIds: ["bg_0", "alice_threeview", "alice_figure", "alice_action"],
    imageDoneIds: ["bg_0"],
  }),
  1: light({
    script: true, imageTotal: 4, imageDone: 1,
    imageIds: ["bg_1", "alice_threeview", "alice_figure", "alice_action"],
    imageDoneIds: ["bg_1"],
  }),
};
const d = summarizeImagePlan(shared, [0, 1]);
assert(d.total === 5, `跨章共享的项目级资产只能算一次：期望 5，实际 ${d.total}`);
assert(d.done === 2, `已生成同样去重：期望 2，实际 ${d.done}`);
assert(d.missing === 3, `待生成期望 3，实际 ${d.missing}`);
assert(
  missingImagesInChapters(shared, [0, 1]) === 3,
  `批量确认的"图像待生成约 N 张"同样要去重：期望 3，实际 ${missingImagesInChapters(shared, [0, 1])}`,
);

console.log("=== image plan stats tests passed ===");
