import type { ApiConfig, ChapterInfo } from "./types";
import { languageName } from "./types";
import { chatCompletion } from "../api/openaiCompatible";
import { inputCharBudgetForText, outputTokensForText } from "../api/providers";
import { splitNovelForAgent } from "./textSplit";
import { log as logger } from "../utils/logger";

export interface TranslatedChapter {
  title: string;
  text: string;
}

const SYSTEM_PROMPT = `你是专业小说翻译。把用户提供的小说章节忠实翻译成指定语言。
规则：
1. 忠实原文，保持段落结构与情节；不要增删内容。
2. 人名、地名、专有名词采用目标语言惯用译法，全书保持一致。
3. 第一段译文时：第一行为「标题：」+ 翻译后的章节标题，空一行后输出翻译后的正文；后续片段只输出正文。
4. 只输出标题与正文，不要输出任何解释、注释或多余文字。`;

/** 首块译文标题解析（1428 纯函数，便于单测）：
 *  - 显式「标题：<译文>」前缀最可靠，无条件采纳；
 *  - 其次：模型常输出 `译文标题\n正文`（无空行）。只要首行像标题（短、不以句末标点结尾）且后面有正文
 *    就提取为标题——旧实现只认「空一行」，漏掉标题后标题保留原文语言、标题行还混进正文被配音；
 *  - 无空行时收紧长度（≤40）降低把正文首句误当标题的风险；
 *  - 不满足则返回 null，由调用方整块当正文并保留原文标题。 */
export function splitTranslatedFirstBlock(raw: string, fallbackTitle: string): { title: string; body: string } | null {
  const lines = raw.split("\n");
  const firstLine = (lines[0] || "").trim();
  if (!firstLine) return null;
  const hasBody = lines.slice(1).some((l) => l.trim() !== "");
  if (!hasBody) return null;
  if (/^标题[:：]/.test(firstLine)) {
    const t = firstLine.replace(/^标题[:：]\s*/, "").trim();
    return { title: t || fallbackTitle, body: lines.slice(1).join("\n").trim() };
  }
  const blankSecond = (lines[1] ?? "").trim() === "";
  const titleLooksValid = firstLine.length <= 60 && !/[。！？!?.]$/.test(firstLine);
  if (titleLooksValid && (blankSecond || firstLine.length <= 40)) {
    return { title: firstLine, body: lines.slice(1).join("\n").trim() };
  }
  return null;
}

/** 翻译单个章节：超长章节按上下文预算分段翻译后拼接（#781）；
 *  返回翻译后的标题 + 正文 */
export async function translateChapter(
  cfg: ApiConfig,
  chapter: ChapterInfo,
  language: string,
  onUsage?: (pt: number, ct: number) => void,
  feedback?: string,
): Promise<TranslatedChapter> {
  const fb = feedback ? `\n\n翻译备注（请严格参考）：${feedback}` : "";
  const chunks = splitNovelForAgent(chapter.text, inputCharBudgetForText(cfg, chapter.text));
  const title = chapter.title;
  const parts: string[] = [];
  let translatedTitle: string | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i].trim();
    const first = i === 0;
    const user = first
      ? `目标语言：${languageName(language)}${fb}\n\n章节标题：${title}\n\n原文：\n${chunk}`
      : `目标语言：${languageName(language)}${fb}\n\n这是章节正文的后续片段（第 ${i + 1}/${chunks.length} 段），请只输出译文的正文，不要输出标题或解释：\n${chunk}`;
    const r = await chatCompletion(
      cfg,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      { maxTokens: outputTokensForText(cfg, `${SYSTEM_PROMPT}\n${user}`), temperature: 0.3, onUsage },
    );
    const raw = (r.content || "").trim();
    // 截断/空结果不能缓存复用：finish_reason=length 说明译文被砍断，静默入库会永久使用残缺译文
    if (r.finishReason === "length") {
      throw new Error(`翻译结果被截断（第 ${i + 1}/${chunks.length} 段达到输出上限）：请调大输出上限或缩短章节后重试`);
    }
    if (!raw) throw new Error(`翻译返回为空（第 ${i + 1}/${chunks.length} 段）`);
    if (!first) {
      parts.push(raw);
      continue;
    }
    const parsed = splitTranslatedFirstBlock(raw, title);
    if (parsed) {
      translatedTitle = parsed.title;
      parts.push(parsed.body || raw);
    } else {
      // 格式不符（模型直接输出正文/无法识别标题行）时整体作为正文，但记 warn 方便定位
      // 「标题未翻译/标题行混入正文」——旧实现静默吞掉且错误译文会被缓存复用。
      const head = (raw.split("\n")[0] || "").trim();
      if (head && head.length <= 60 && !/[。！？!?.]$/.test(head)) {
        logger.warn("translate", "译文首块疑似含未识别标题行，已按正文保留并沿用原文标题", {
          chapter: title,
          head: head.slice(0, 40),
        });
      }
      parts.push(raw);
    }
  }

  return { title: translatedTitle ?? title, text: parts.join("\n\n") };
}
