import type { ChapterLight } from "../composables/useChapterStatus";

/** 图片计划统计（生成前总账）：按章节灯聚合「共多少张 / 已生成 / 待生成」 */
interface ImagePlanSummary {
  total: number;
  done: number;
  missing: number;
  /** 已有剧本、可参与统计的章节数 */
  knownChapters: number;
  /** 尚无剧本、无法计算图片数的章节数（如实告知用户） */
  unknownChapters: number;
}

function emptyImagePlanSummary(): ImagePlanSummary {
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
  // 必须按任务 id 去重，不能各章相加：角色三视图/立绘/表情/动作是**项目级资产**，
  // 同一个角色的立绘会被它出场的每一章同时计入。实测某项目 30 章灯相加得 3566，
  // 而全局唯一任务只有 857 —— 相加会让"图片共 N 张"虚高约 4 倍，把成本说错。
  const seen = new Set<string>();
  const done = new Set<string>();
  for (const index of chapterIndices) {
    const light = lights[index];
    if (!light || !light.script) {
      out.unknownChapters++;
      continue;
    }
    out.knownChapters++;
    for (const id of light.imageIds ?? []) seen.add(id);
    for (const id of light.imageDoneIds ?? []) done.add(id);
  }
  out.total = seen.size;
  out.done = done.size;
  out.missing = Math.max(0, out.total - out.done);
  return out;
}

/** 指定章节范围内待生成的图片张数（缺剧本的章节不计入） */
export function missingImagesInChapters(
  lights: Record<number, ChapterLight | undefined>,
  chapterIndices: number[],
): number {
  // 同样按 id 去重，与 summarizeImagePlan 口径一致：批量运行确认里的
  // "图像待生成约 N 张"是给用户看的成本提示，各章相加同样会虚高。
  const missing = new Set<string>();
  for (const index of chapterIndices) {
    const light = lights[index];
    if (!light) continue;
    const done = new Set(light.imageDoneIds ?? []);
    for (const id of light.imageIds ?? []) if (!done.has(id)) missing.add(id);
  }
  return missing.size;
}
