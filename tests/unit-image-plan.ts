/**
 * 生成前图片总账（新需求）：按章节灯聚合 共多少张 / 已生成 / 待生成。
 * 口径必须与章节灯一致（已有剧本才可统计；未生成剧本的章节单独计数）。
 */
import { missingImagesInChapters, summarizeImagePlan } from "../src/core/imageStats";
import type { ChapterLight } from "../src/composables/useChapterStatus";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function light(partial: Partial<ChapterLight>): ChapterLight {
  return { script: false, legacyScript: false, imageDone: 0, imageTotal: 0, voiceDone: 0, voiceTotal: 0, voiceSkipped: true, ...partial };
}

// 1) 已有剧本的章节：总数/已生成/待生成按灯聚合
const lights: Record<number, ChapterLight | undefined> = {
  0: light({ script: true, imageTotal: 10, imageDone: 4 }),
  1: light({ script: true, imageTotal: 5, imageDone: 5 }),
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
assert(missingImagesInChapters(lights, [0, 1]) === 6, "多章求和应为 6");

// 4) 已生成多于总数（换过剧本）时不出现负数
const odd = summarizeImagePlan({ 0: light({ script: true, imageTotal: 3, imageDone: 5 }) }, [0]);
assert(odd.missing === 0, "已生成超过总数时待生成应为 0，不得为负");

console.log("=== image plan stats tests passed ===");
