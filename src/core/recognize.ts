import type { ApiConfig } from "./types";
import { chatVision } from "../api/openaiCompatible";
import { extractJson } from "../api/openaiCompatible";

const STYLE_SYSTEM = `你是画风分析专家。分析用户给出的图片的视觉风格，输出一段可直接用于 AI 绘图的英文风格约束。
要求：
1. 涵盖：画风类型（如日式动画、厚涂、水彩、赛璐璐）、线条（粗细/利落度）、上色（平涂/渐变/饱和度）、光影、细节程度、氛围色调；
2. 用英文输出，句式固定为 "unified anime style, ..." 之类，可直接追加到绘图 prompt 后；
3. 只输出风格描述本身，不要任何解释、前后缀文字。`;

const CHAR_SYSTEM = `你是角色设定师。根据用户给出的角色参考图，输出严格的 JSON（不要 markdown 代码块，不要其他文字）：
{
  "name": "角色中文名（若无则留空）",
  "appearance": "中文外貌描述（发型、瞳色、脸型、体型、气质）",
  "clothing": "中文服装描述（颜色、款式、配饰）",
  "personality": "中文性格描述（一句话）",
  "voiceDesc": "适合该角色的中文音色描述（如"清冷的少女声"）",
  "imagePrompt": "生成该角色立绘的完整英文 prompt：全身像、姿态自然、动漫风格、纯绿背景，需严格还原图中人物的外观/服装/配色",
  "threeViewPrompt": "生成该角色三视图（正面/侧面/背面）参考图的英文 prompt：同一角色、站姿自然、表情平静、全身可见、纯绿背景"
}`;

export interface RecognizedCharacter {
  name?: string;
  appearance?: string;
  clothing?: string;
  personality?: string;
  voiceDesc?: string;
  imagePrompt?: string;
  threeViewPrompt?: string;
}

/** 用多模态模型识别图片画风，返回可直接用于绘图的英文风格约束 */
export async function recognizeStyle(
  cfg: ApiConfig,
  imageB64: string,
  onUsage?: (pt: number, ct: number) => void,
): Promise<string> {
  const reply = await chatVision(cfg, STYLE_SYSTEM, "请识别这张图的画风。", imageB64, { maxTokens: 300, onUsage });
  const clean = (reply || "").trim().replace(/^画风[:：]?\s*/i, "");
  return clean || "unified anime style, consistent art direction";
}

/** 用多模态模型根据角色参考图识别角色设定（外貌/服装/性格/立绘与三视图提示词） */
export async function recognizeCharacter(
  cfg: ApiConfig,
  imageB64: string,
  onUsage?: (pt: number, ct: number) => void,
): Promise<RecognizedCharacter> {
  const reply = await chatVision(cfg, CHAR_SYSTEM, "请根据这张角色参考图输出角色设定 JSON。", imageB64, {
    maxTokens: 1400,
    onUsage,
  });
  const data = extractJson(reply) as RecognizedCharacter;
  return {
    name: typeof data?.name === "string" ? data.name : "",
    appearance: typeof data?.appearance === "string" ? data.appearance : "",
    clothing: typeof data?.clothing === "string" ? data.clothing : "",
    personality: typeof data?.personality === "string" ? data.personality : "",
    voiceDesc: typeof data?.voiceDesc === "string" ? data.voiceDesc : "",
    imagePrompt: typeof data?.imagePrompt === "string" ? data.imagePrompt : "",
    threeViewPrompt: typeof data?.threeViewPrompt === "string" ? data.threeViewPrompt : "",
  };
}
