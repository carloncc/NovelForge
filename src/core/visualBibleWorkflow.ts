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
