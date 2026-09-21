import type { ChapterLight } from "../composables/useChapterStatus";

/** 图片计划统计（生成前总账）：按章节灯聚合「共多少张 / 已生成 / 待生成」 */
export interface ImagePlanSummary {
  total: number;
  done: number;
  missing: number;
  /** 已有剧本、可参与统计的章节数 */
  knownChapters: number;
  /** 尚无剧本、无法计算图片数的章节数（如实告知用户） */
  unknownChapters: number;
}

export function emptyImagePlanSummary(): ImagePlanSummary {
  return { total: 0, done: 0, missing: 0, knownChapters: 0, unknownChapters: 0 };
}

/**
 * 汇总给定章节的图片总账（纯函数，供 generate store 与单测共用）：
 * 没有剧本的章节算不出本章要用哪些图，计入 unknownChapters 而不是当成 0 混入总数。
 */
export function summarizeImagePlan(
  lights: Record<number, ChapterLight | undefined>,
  chapterIndices: number[],
): ImagePlanSummary {
  const out = emptyImagePlanSummary();
  for (const index of chapterIndices) {
    const light = lights[index];
    if (!light || !light.script) {
      out.unknownChapters++;
      continue;
    }
    out.knownChapters++;
    out.total += light.imageTotal;
    out.done += light.imageDone;
  }
  out.missing = Math.max(0, out.total - out.done);
  return out;
}

/** 指定章节范围内待生成的图片张数（缺剧本的章节不计入） */
export function missingImagesInChapters(
  lights: Record<number, ChapterLight | undefined>,
  chapterIndices: number[],
): number {
  let missing = 0;
  for (const index of chapterIndices) {
    const light = lights[index];
    if (light) missing += Math.max(0, light.imageTotal - light.imageDone);
  }
  return missing;
}
