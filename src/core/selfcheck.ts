import type { ApiConfig, ImageReference } from "./types";
import { chatVision, VisionApiError } from "../api/openaiCompatible";
import { log } from "../utils/logger";

export interface SelfCheckResult {
  ok: boolean;
  reason: string;
}

export interface SelfCheckOptions {
  onUsage?: (promptTokens: number, completionTokens: number) => void;
  references?: ImageReference[];
}

const SYSTEM = `你是视觉质检员。我会给你一张图片和它应满足的要求（可能还会附一张参考图），请严格判断：
1. 人物/物体与要求描述一致（发型、瞳色、服装、配色、动作姿态）；
2. 若附有参考图：图中人物必须与参考图是同一角色（外貌、发型、瞳色、服装与配色一致），画风一致；
3. 无畸形：不缺胳膊少腿、不多个肢体、五官正常；
4. 画风统一，人物完整可见，背景是纯色（绿幕）；
5. 比例正常，没有变形或被拉伸。
只输出一行：先写"符合"或"不符合"，然后跟一句简短原因。`;

function referenceRoleInstructions(references: ImageReference[]): string {
  if (!references.length) return "";
  const rolePriority = { identity: 0, style: 1, structure: 2 } as const;
  const ordered = references
    .map((reference, index) => ({ reference, index }))
    .sort((left, right) => rolePriority[left.reference.role] - rolePriority[right.reference.role] || left.index - right.index);
  const labels = ordered.map(({ reference }, index) => {
    const instruction = reference.role === "identity"
      ? "Judge whether the generated subject is the same character or object."
      : reference.role === "style"
        ? "Judge only art style, palette, rendering, and lighting."
        : "Judge only pose, composition, camera, and spatial structure.";
    return `REFERENCE IMAGE ${index + 1} ROLE: ${reference.role.toUpperCase()} - ${instruction}`;
  });
  return `\n\n${labels.join("\n")}\nDo not judge identity from STYLE or STRUCTURE reference images.`;
}

/** 用多模态模型核对生成图是否达标；判断结果正常返回，配置/能力/服务不可用错误向上抛出。 */
export async function verifyImage(
  cfg: ApiConfig,
  imageB64: string,
  expected: string,
  options: SelfCheckOptions = {},
): Promise<SelfCheckResult> {
  try {
    const references = options.references ?? [];
    const ref = referenceRoleInstructions(references);
    const reply = await chatVision(
      cfg,
      SYSTEM,
      `应满足的要求：${expected.slice(0, 500)}${ref}\n\n请判断这张图是否符合。`,
      imageB64,
      { maxTokens: 200, onUsage: options.onUsage },
      references,
    );
    const ok = /^符合/.test(reply.trim()) || !/(不符合|不满足|有问题|畸形|变形|不是同一|不同角色)/.test(reply);
    return { ok, reason: reply.trim().slice(0, 200) };
  } catch (e) {
    if (e instanceof VisionApiError) throw e;
    const message = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e);
    log.error("selfcheck", "图像自检服务不可用", { error: message });
    throw new VisionApiError(`图片识别 API 暂时不可用：${message}`, "VISION_UNAVAILABLE");
  }
}
