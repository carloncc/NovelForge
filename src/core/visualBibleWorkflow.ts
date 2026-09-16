import { ReferenceImageError } from "../api/providers";
import { VisionApiError } from "../api/openaiCompatible";
import type { ProjectVisualBible, StageKey } from "./types";
import { STAGE_ORDER } from "./types";
import { VisualBibleApprovalRequiredError } from "./visualBible";

const TEXT_STAGE_SET = new Set<StageKey>(["split", "translate", "extract", "script"]);
const RESUME_STAGE_SET = new Set<StageKey>(["image", "voice", "assemble"]);

export interface VisualBibleErrorContext {
  imageModel?: string;
  visionModel?: string;
}

export function imageRunPreparationStages(selectedStages: StageKey[], hasPreparedResult: boolean): StageKey[] {
  if (!selectedStages.includes("image")) return [];
  const selectedTextStages = selectedStages.filter((stage) => TEXT_STAGE_SET.has(stage));
  if (selectedTextStages.length === 0 && hasPreparedResult) return [];
  const requiredStages = new Set<StageKey>([...selectedTextStages, "extract", "script"]);
  return STAGE_ORDER.filter((stage) => requiredStages.has(stage));
}

export function resumeStagesAfterVisualApproval(selectedStages: StageKey[]): StageKey[] {
  return STAGE_ORDER.filter((stage) => RESUME_STAGE_SET.has(stage) && selectedStages.includes(stage));
}

/**
 * 批准视觉守门后要续跑的阶段：只认「被守门挡下的那次运行」记下来的计划。
 *
 * 绝不能在计划为空时回退成「当前勾选的阶段」——阶段勾选默认全开，那样用户只是点一下
 * 「批准并续跑生成」就会静默地按全书范围重跑图像/配音，白烧一遍图像费用。
 * 没有待续跑计划 = 批准本身就是全部动作（只盖章，不生成）。
 */
export function approvalResumePlan(pendingStages: StageKey[] | null | undefined): StageKey[] {
  if (!pendingStages || pendingStages.length === 0) return [];
  return STAGE_ORDER.filter((stage) => RESUME_STAGE_SET.has(stage) && pendingStages.includes(stage));
}
/**
 * 章节范围的统一中文文案：null/undefined = 全部章节，空数组 = 未选任何章节。
 * 「全书/全部」措辞由调用点传入，因为各处的口径不同（日志说「全部」，确认框说「全书」）。
 *
 * 存在的意义：阶段重跑会隐式继承全局章节勾选，确认框若写死「全书」就会与实际执行范围不符，
 * 变成对用户计费范围的假承诺。
 */
export function chapterScopeText(scope: readonly number[] | null | undefined, allLabel = "全书"): string {
  if (scope === undefined || scope === null) return allLabel;
  if (scope.length === 0) return "未选任何章节";
  const nums = [...scope].sort((a, b) => a - b).map((n) => n + 1);
  return `仅第 ${nums.join("、")} 章`;
}

export function visualBibleNeedsReview(bible: ProjectVisualBible | null | undefined): boolean {
  return !bible || bible.status !== "approved";
}

export function visualBibleErrorMessage(error: unknown, context: VisualBibleErrorContext): string {
  if (error instanceof ReferenceImageError) {
    if (error.code === "REFERENCE_UNSUPPORTED") {
      return `图片模型「${context.imageModel || "未配置"}」无法保留所需参考图。请在「API 配置 > 图片生成」中启用图生图，并检查参考图数量设置。详情：${error.message}`;
    }
    return `视觉参考文件缺失或不可读。请重新上传对应图片后重试。详情：${error.message}`;
  }
  if (error instanceof VisionApiError) {
    return `图片识别模型「${context.visionModel || "未配置"}」无法完成分析。请在「API 配置 > 图片识别」中选择支持 image_url 的视觉模型。详情：${error.message}`;
  }
  if (error instanceof VisualBibleApprovalRequiredError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
