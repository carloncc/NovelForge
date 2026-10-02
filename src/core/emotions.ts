import { normalizeEntityId, stableHash } from "./ids";

/**
 * 表情 id 归一化（#1492/#1496）。
 *
 * 背景：立绘差分的**文件名**用的是归一化后的 id（`figure_<char>_<emoId>.png`），而
 * 表情集**值**会被当作英文提示词片段喂给绘图模型（emotionPrompt 的 label 参数）。
 * 旧实现两处口径不一致：
 *  - images.ts / 素材页用 sanitizeId（非 ASCII → 一长串 "_"），
 *  - extract.ts 存原始值、素材页又拿原始值当 map key，
 * 于是 AI 返回中文表情（「微笑」「大笑」）时：① 界面恒显示"缺图"（即使图已生成）；
 * ② 两个**等长**的中文表情消毒后得到**同一个** id，后者被静默丢弃或覆盖；
 * ③ 提示词里被塞进中文，模型只能靠猜。
 *
 * 这里做一次显式归一化：已知情绪词映射到标准英文 id（提示词里本来就该是英文），
 * 未知值用「emo_ + 稳定哈希」保底——同一输入跨运行稳定、不同输入不碰撞，
 * 与 normalizeEntityId 处理中文角色名的思路一致（ids.ts 的注释里有同样的踩坑记录）。
 */

/** 常见情绪词 → 标准英文 id（覆盖中/英/日常见写法；键一律按小写去空白比较） */
const EMOTION_ALIASES: Record<string, string> = {
  normal: "normal",
  neutral: "normal",
  default: "normal",
  默认: "normal",
  平静: "normal",
  平静的: "normal",
  无表情: "normal",
  普通: "normal",
  happy: "happy",
  smile: "happy",
  smiling: "happy",
  joy: "happy",
  开心: "happy",
  高兴: "happy",
  快乐: "happy",
  微笑: "happy",
  笑: "happy",
  笑容: "happy",
  嬉笑: "happy",
  sad: "sad",
  sorrow: "sad",
  crying: "sad",
  悲伤: "sad",
  难过: "sad",
  伤心: "sad",
  哭: "sad",
  哭泣: "sad",
  流泪: "sad",
  angry: "angry",
  anger: "angry",
  愤怒: "angry",
  生气: "angry",
  恼怒: "angry",
  surprised: "surprised",
  surprise: "surprised",
  shocked: "surprised",
  惊讶: "surprised",
  吃惊: "surprised",
  震惊: "surprised",
  shy: "shy",
  shyly: "shy",
  害羞: "shy",
  羞涩: "shy",
  embarrassed: "embarrassed",
  尴尬: "embarrassed",
  囧: "embarrassed",
  calm: "calm",
  冷静: "calm",
  serious: "serious",
  严肃: "serious",
  认真: "serious",
  confused: "confused",
  困惑: "confused",
  疑惑: "confused",
  worried: "worried",
  担心: "worried",
  忧虑: "worried",
  scared: "scared",
  fear: "scared",
  害怕: "scared",
  恐惧: "scared",
  pain: "pain",
  痛苦: "pain",
  determined: "determined",
  坚定: "determined",
  决然: "determined",
  proud: "proud",
  得意: "proud",
  骄傲: "proud",
  cold: "cold",
  冷淡: "cold",
  冷漠: "cold",
};

/** 归一化单个表情值为稳定英文 id；空值返回 ""。 */
export function normalizeEmotionId(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const mapped = EMOTION_ALIASES[text.toLowerCase()];
  if (mapped) return mapped;
  // 纯 ASCII 标识：小写化并清洗为文件名安全字符（与旧 sanitizeId 行为兼容）
  if (!/[^\x00-\x7F]/.test(text)) {
    const cleaned = text.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
    if (/[a-z0-9]/.test(cleaned)) return cleaned;
  }
  // 未知非 ASCII 词（表外的中文情绪）：前缀 + 稳定哈希，保证可区分
  return normalizeEntityId(text, "emo") || `emo_${stableHash(text)}`;
}

/**
 * 归一化角色表情集：映射到标准 id、按 id 去重、强制包含 normal、上限 10。
 *
 * - 强制 normal：表情集缺 normal 会导致默认立绘整张缺失、其它差分的 refFromTask 全部断链；
 * - 按 id 去重：旧实现按原始值去重，「微笑」「大笑」这类等长中文会被消毒成同一个文件名，
 *   生成任务互相覆盖，这里在提取阶段就收敛掉；
 * - 上限 10：兜底模型超量返回导致立绘张数/费用暴涨。
 */
export function normalizeCharacterEmotions(raw: unknown): string[] {
  const out: string[] = ["normal"];
  const seen = new Set<string>(["normal"]);
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const id = normalizeEmotionId(item);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= 10) break;
    }
  }
  return out;
}
