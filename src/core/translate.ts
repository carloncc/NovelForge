import type { ApiConfig, ChapterInfo } from "./types";
import { languageName } from "./types";
import { chatCompletion } from "../api/openaiCompatible";
import { inputCharBudgetForText, outputTokensForText } from "../api/providers";
import { splitNovelForAgent } from "./textSplit";

export interface TranslatedChapter {
  title: string;
  text: string;
}

const SYSTEM_PROMPT = `你是专业小说翻译。把用户提供的小说章节忠实翻译成指定语言。
规则：
1. 忠实原文，保持段落结构与情节；不要增删内容。
2. 人名、地名、专有名词采用目标语言惯用译法，全书保持一致。
3. 第一段译文时：第一行为翻译后的章节标题，空一行后输出翻译后的正文；后续片段只输出正文。
4. 只输出标题与正文，不要输出任何解释、注释或多余文字。`;

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
    const lines = raw.split("\n");
    const firstLine = (lines[0] || "").trim();
    const blankSecond = (lines[1] ?? "").trim() === "";
    // 首行必须是「像标题」的短行：过长或以句末标点结尾的更像正文，不能当标题吞掉
    const titleLooksValid = firstLine.length > 0 && firstLine.length <= 60 && !/[。！？!?]$/.test(firstLine);
    if (blankSecond && titleLooksValid && lines.length >= 3) {
      translatedTitle = firstLine.replace(/^标题[:：]\s*/, "").trim() || title;
      const body = lines.slice(1).join("\n").trim();
      parts.push(body || raw);
    } else {
      // 格式不符（模型直接输出正文/缺空行/首行像正文）时整体作为正文：
      // 旧实现把首行一律当标题，格式错误时正文第一段被吞掉，且错误译文还会被缓存复用
      parts.push(raw);
    }
  }

  return { title: translatedTitle ?? title, text: parts.join("\n\n") };
}
