import type { ApiConfig } from "./types";
import { chatVision } from "../api/openaiCompatible";
import { extractJson } from "../api/openaiCompatible";
import { log } from "../utils/logger";

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
  "imagePrompt": "生成该角色立绘的完整英文 prompt：全身像、姿态自然、动漫风格；只描述人物本身，禁止写任何背景/底色（系统会自动附加纯绿幕），需严格还原图中人物的外观/服装/配色",
  "threeViewPrompt": "生成该角色三视图（正面/侧面/背面）参考图的英文 prompt：同一角色、站姿自然、表情平静、全身可见；同样禁止写任何背景/底色（系统会自动附加纯绿幕）"
}`;

const REFERENCE_DESC_SYSTEM = `你是视觉小说风格分析助手。根据用户给出的参考图，输出严格 JSON（不要 markdown 代码块，不要其他文字）：
{
  "prompt": "一段英文提示词片段，用于在后续 AI 绘图中约束画风一致性。只提取风格要素，禁止输出人物特征。"
}

风格要素（必须提取）：
- 画风类型（anime cel shading / watercolor / thick paint / semi-realistic 等）
- 色盘（3-5 个主导色调及 hex 或英文名，如 navy blue #1a1a4e, warm pink, cream）
- 线条风格（clean crisp / sketchy loose / thick heavy / soft diffused）
- 光影（方向、软硬、对比度，如 backlit rim lighting, soft ambient, dramatic chiaroscuro）
- 笔触质感（smooth gradient / visible brush strokes / texture grain）
- 氛围/色调（warm or cool, melancholy, bright, cinematic）

禁止输出的内容（任何情况下都不要描述）：
- 人物外貌：头发颜色、发型、眼睛颜色、肤色、体型、性别
- 人物服装：校服、连衣裙、颜色、款式、配饰
- 人物特征：表情、姿势、动作
- 具体场景内容：教室、走廊、医院（只说光影/色调，不说地点）

输出示例：
{
  "prompt": "cel-shaded anime style, cool navy-and-violet palette, clean crisp linework, soft backlit rim lighting, dramatic moody atmosphere"
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
  if (!clean) throw new Error("图片识别 API 未返回画风描述");
  return clean;
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

/** 用多模态模型把参考图描述成英文提示词片段（供后续图生图严格还原参考图）。失败返回空串。 */
export async function describeReferenceImage(
  cfg: ApiConfig,
  imageB64: string,
  onUsage?: (pt: number, ct: number) => void,
): Promise<string> {
  const reply = await chatVision(cfg, REFERENCE_DESC_SYSTEM, "请描述这张参考图。", imageB64, {
    maxTokens: 800,
    temperature: 0.1,
    timeoutSecs: 30,
    onUsage,
  });
  const data = extractJson(reply) as { prompt?: unknown };
  const prompt = typeof data?.prompt === "string" ? data.prompt.trim() : "";
  if (!prompt) throw new Error("图片识别 API 未返回参考图描述");
  return prompt;
}

/**
 * 进程级缓存版本的 describeReferenceImage：同一张参考图（按内容哈希）只调用一次视觉模型。
 * 项目中大量任务共享同一张风格锚图/身份图，避免 N 次重复 vision 调用（耗时 + 计费）。
 * 参考图描述是「可选增强」：视觉通道限流（429）或失败时快速降级返回空串，绝不阻塞/反复重试，
 * 否则 205 个图像任务同时打视觉 API 会触发大量 429（用户实测 MiniMax 视觉通道连续 429）。
 *
 * 并发保护：模块级信号量把视觉描述请求压到 1，避免与图像生成并发叠加打爆服务端。
 * 失败缓存：失败（含 429）后冷却 30s，期间同一参考图直接返回空（降级），避免反复重试浪费。
 */
const referenceDescCache = new Map<string, Promise<string>>();
const referenceDescFailedAt = new Map<string, number>();
const REF_DESC_FAIL_COOLDOWN_MS = 30_000;

// 健康开关：连续 2 次失败（429 限流或超时）后，本次进程内禁用参考图描述增强，
// 全部降级为按原提示词生成，避免视觉通道故障阻塞整个图像阶段（每个任务都等串行描述）。
const REF_DESC_MAX_CONSECUTIVE_FAILS = 2;
let refDescConsecutiveFails = 0;
let refDescDisabled = false;

export function isReferenceDescriptionDisabled(): boolean {
  return refDescDisabled;
}

// 简单信号量：同时最多 1 个参考图描述请求在途（视觉通道限流敏感，串行最稳）
let refDescInFlight = 0;
const refDescWaiters: Array<() => void> = [];
function acquireRefDescSlot(): Promise<void> {
  if (refDescInFlight < 1) {
    refDescInFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => refDescWaiters.push(resolve));
}
function releaseRefDescSlot(): void {
  refDescInFlight--;
  const next = refDescWaiters.shift();
  if (next) next();
}

function referenceDescKey(imageB64: string): string {
  return `${imageB64.length}:${imageB64.slice(0, 256)}`;
}

export function describeReferenceImageCached(
  cfg: ApiConfig,
  imageB64: string,
  onUsage?: (pt: number, ct: number) => void,
): Promise<string> {
  // 健康开关已触发：直接降级（返回空描述），不再调用视觉 API
  if (refDescDisabled) return Promise.resolve("");
  const key = referenceDescKey(imageB64);
  const hit = referenceDescCache.get(key);
  if (hit) return hit;
  // 失败冷却期内直接降级（返回空描述），避免同一参考图反复触发视觉 API 加重限流
  const failedAt = referenceDescFailedAt.get(key);
  if (failedAt !== undefined && Date.now() - failedAt < REF_DESC_FAIL_COOLDOWN_MS) {
    return Promise.resolve("");
  }
  const pending = (async () => {
    await acquireRefDescSlot();
    try {
      const description = await describeReferenceImage(cfg, imageB64, onUsage);
      refDescConsecutiveFails = 0;
      return description;
    } catch (e) {
      referenceDescFailedAt.set(key, Date.now());
      // 连续失败达到阈值 → 本次进程内禁用视觉描述增强（多为 429 限流，继续调用只会更糟）
      refDescConsecutiveFails++;
      if (refDescConsecutiveFails >= REF_DESC_MAX_CONSECUTIVE_FAILS && !refDescDisabled) {
        refDescDisabled = true;
        refDescConsecutiveFails = 0;
        log.warn("recognize", "参考图描述连续失败（疑似视觉通道限流），本次生成已禁用该增强", { fails: REF_DESC_MAX_CONSECUTIVE_FAILS });
      }
      throw e;
    } finally {
      releaseRefDescSlot();
    }
  })();
  referenceDescCache.set(key, pending.catch(() => "").then((v) => {
    // 失败时从成功缓存移除，但保留失败冷却
    if (v === "") {
      referenceDescCache.delete(key);
    }
    return v;
  }));
  return referenceDescCache.get(key)!;
}
