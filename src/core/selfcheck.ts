import type { ApiConfig } from "./types";
import { chatVision } from "../api/openaiCompatible";
import { log } from "../utils/logger";

export interface SelfCheckResult {
  ok: boolean;
  reason: string;
}

const SYSTEM = `你是视觉质检员。我会给你一张图片和它应满足的要求，请严格判断：
1. 人物/物体与要求描述一致（发型、瞳色、服装、配色、动作姿态）；
2. 无畸形：不缺胳膊少腿、不多个肢体、五官正常；
3. 画风统一，人物完整可见，背景是纯色（绿幕）；
4. 比例正常，没有变形或被拉伸。
只输出一行：先写"符合"或"不符合"，然后跟一句简短原因。`;

/** 用多模态模型核对生成图是否达标；失败时视为符合（不阻断生成） */
export async function verifyImage(
  cfg: ApiConfig,
  imageB64: string,
  expected: string,
  onUsage?: (pt: number, ct: number) => void,
): Promise<SelfCheckResult> {
  try {
    const reply = await chatVision(
      cfg,
      SYSTEM,
      `应满足的要求：${expected.slice(0, 500)}\n\n请判断这张图是否符合。`,
      imageB64,
      { maxTokens: 200, onUsage },
    );
    const ok = !/(不符合|不满足|有问题|错误|不一致|畸形|缺|多余|变形)/.test(reply);
    return { ok, reason: reply.trim().slice(0, 200) };
  } catch (e) {
    log.warn("selfcheck", "图像自检不可用（跳过，保留原图）", {
      error: e instanceof Error ? e.message : String(e),
    });
    return { ok: true, reason: "自检不可用（保留原图）" };
  }
}
