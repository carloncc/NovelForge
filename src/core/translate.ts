import type { ApiConfig, ChapterInfo } from "./types";
import { languageName } from "./types";
import { chatCompletion } from "../api/openaiCompatible";

export interface TranslatedChapter {
  title: string;
  text: string;
}

const SYSTEM_PROMPT = `你是专业小说翻译。把用户提供的小说章节忠实翻译成指定语言。
规则：
1. 忠实原文，保持段落结构与情节；不要增删内容。
2. 人名、地名、专有名词采用目标语言惯用译法，全书保持一致。
3. 输出格式：第一行为翻译后的章节标题，空一行后输出翻译后的正文。
4. 只输出标题与正文，不要输出任何解释、注释或多余文字。`;

/** 翻译单个章节：返回翻译后的标题 + 正文 */
export async function translateChapter(
  cfg: ApiConfig,
  chapter: ChapterInfo,
  language: string,
  onUsage?: (pt: number, ct: number) => void,
  feedback?: string,
): Promise<TranslatedChapter> {
  const fb = feedback ? `\n\n翻译备注（请严格参考）：${feedback}` : "";
  const user = `目标语言：${languageName(language)}${fb}\n\n章节标题：${chapter.title}\n\n原文：\n${chapter.text}`;
  const r = await chatCompletion(
    cfg,
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    { maxTokens: 16000, temperature: 0.3, onUsage },
  );
  const raw = (r.content || "").trim();
  const lines = raw.split("\n");
  const title = (lines[0] || "").replace(/^标题[:：]\s*/, "").trim() || chapter.title;
  const body = lines.slice(1).join("\n").trim();
  const text = body || raw;
  return { title, text };
}
