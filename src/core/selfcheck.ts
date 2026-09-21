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

/** 负面词表：回覆中出现且未被否定时判不通过 */
const NEGATIVE_TERMS = ["不符合", "不满足", "有问题", "畸形", "变形", "不是同一", "不同角色", "无法判断", "未知", "看不清", "不能确定"];

/** 负面词紧邻前的否定词（无畸形 / 没有变形 / 未见明显变形），命中说明是在描述「没问题」 */
const NEGATION_BEFORE_TERM = /(不|无|没|未)[^。！？!?；;，,、]{0,6}$/;

/**
 * 判定回覆是否通过。模型通过时也会复述检查项（如「符合，人物无畸形」），
 * 早期实现按「含负面词即不通过」会把这些正向描述误判为失败（#780），
 * 这里改为：只有未被否定的负面词才判不通过。
 */
export function parseSelfCheckReply(reply: string): SelfCheckResult {
  const trimmed = reply.trim();
  let failed = false;
  for (const term of NEGATIVE_TERMS) {
    let from = 0;
    for (;;) {
      const at = trimmed.indexOf(term, from);
      if (at < 0) break;
      from = at + term.length;
      const before = trimmed.slice(Math.max(0, at - 12), at);
      if (NEGATION_BEFORE_TERM.test(before)) continue;
      failed = true;
      break;
    }
    if (failed) break;
  }
  return { ok: /^符合/.test(trimmed) && !failed, reason: trimmed.slice(0, 200) };
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
      `应满足的要求：${expected.slice(0, 1000)}${ref}\n\n请判断这张图是否符合。`,
      imageB64,
      { maxTokens: 200, onUsage: options.onUsage },
      references,
    );
    return parseSelfCheckReply(reply);
  } catch (e) {
    if (e instanceof VisionApiError) throw e;
    const message = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e);
    log.error("selfcheck", "图像自检服务不可用", { error: message });
    throw new VisionApiError(`图片识别 API 暂时不可用：${message}`, "VISION_UNAVAILABLE");
  }
}
