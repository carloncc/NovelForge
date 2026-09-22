import type { ChapterInfo, NovelDoc } from "./types";
import { tauri } from "../utils/tauri";
import { basename, basenameWithoutExt } from "../utils/path";
import { log } from "../utils/logger";

/** 行首序号前缀（#1137）：`1.`/`001、`/`(1)`/`一、` 等网文编号剥离后再匹配标题本体 */
const NUM_PREFIX =
  /^\s*(?:\d{1,4}\s*[.、．:：)）\]]|\d{1,4}\s+|[(（\[]\s*\d{1,4}\s*[)）\]]|[一二三四五六七八九十]+\s*[、.．])\s*/;

/** 章节锚点：编号章 / 序章-终章标记 / 裸序号（`22.标题`）/ 英文标记 */
const CHAPTER_ANCHOR =
  /^(?:第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章回节话篇部幕卷]|序章|序言|楔子|尾声|终章|番外|后记|前言|引子|[0-9零〇一二三四五六七八九十百千万两]+\s*[.、．)）]\s*\S)/;
const CHAPTER_EN_ANCHOR = /^(Chapter|CHAPTER|Episode|episode|Prologue|Epilogue|Act)\b/i;

function isChapterTitle(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length > 60 || trimmed.length < 2) return false;
  // 含句末标点的是正文句子，不是标题（旧实现只看后缀是相同效果；这里收紧到整行，
  // 长标题最多含 、，；等分隔，不含 。！？!?）
  if (/[。！？!?]/.test(trimmed)) return false;
  let core = trimmed;
  const prefix = core.match(NUM_PREFIX);
  if (prefix) core = core.slice(prefix[0].length).trim();
  if (CHAPTER_ANCHOR.test(core)) return true;
  if (CHAPTER_EN_ANCHOR.test(core)) return true;
  return false;
}

/**
 * 小说正文归一化（导入链与追加拼接 joinAppendText 共用，B12）：
 * 清 BOM/回车符、折叠 3 个以上连续换行为一个空行、去首尾空白。
 * 追加拼接与「重启后按源文件重新导入」必须得到完全一致的 fullText——
 * 否则指纹差异会被误判成小说内容变化，触发重分章并作废剧本/卡片缓存。
 */
export function normalizeNovelText(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitChapters(fullText: string, baseTitle: string): ChapterInfo[] {
  const lines = fullText.split(/\r?\n/);
  const chapters: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } = { title: "第一章", lines: [] };
  let anyChapter = false;
  // 首章标题之前的正文（引子/前言碎片）：暂存，碰到第一个标题时并入该章开头
  const preamble: string[] = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (isChapterTitle(line)) {
      current = { title: line.trim(), lines: [] };
      // 首章前的正文（引子/前言碎片）是第一个章节的一部分：并入本章开头而非丢弃，
      // 否则第一章永远从标题行开始、引子无声消失（#1137）
      if (preamble.length) {
        current.lines.push(...preamble);
        preamble.length = 0;
      }
      chapters.push(current);
      anyChapter = true;
    } else if (!anyChapter) {
      preamble.push(raw);
    } else {
      current.lines.push(raw);
    }
  }

  if (!anyChapter) {
    chapters.push({ title: "第一章", lines: lines });
  }

  const merged: ChapterInfo[] = [];
  for (const c of chapters) {
    const text = c.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) continue;
    merged.push({
      index: merged.length,
      title: c.title.trim(),
      text,
      charCount: text.length,
    });
  }

  if (!merged.length) {
    merged.push({ index: 0, title: "第一章", text: fullText.trim(), charCount: fullText.length });
  }
  if (merged.length === 1 && !anyChapter) {
    merged[0].title = baseTitle || "第一章";
  }
  return merged;
}

export async function importNovelFile(path: string): Promise<NovelDoc> {
  const done = log.time("chapters", `导入小说 ${path}`);
  const { text, encoding } = await tauri.readTextFile(path);
  const cleaned = text.replace(/^\uFEFF/, "");
  const fileName = basename(path);
  const baseTitle = basenameWithoutExt(path);
  const chapters = splitChapters(cleaned, baseTitle);
  log.info("chapters", "小说导入完成", {
    path,
    fileName,
    encoding,
    charCount: cleaned.length,
    chapterCount: chapters.length,
    chapterTitles: chapters.map((c) => c.title),
  });
  done(`章节=${chapters.length} 字数=${cleaned.length}`);
  return {
    fileName,
    sourcePath: path,
    sourcePaths: [path],
    encoding,
    fullText: cleaned,
    chapters,
  };
}

/**
 * 多文件合并导入：把所有 txt 按顺序拼接为一部小说，导入时不切章。
 * 章节划分留到「分章」阶段（运行管线时由 AI 完成）。
 */
export async function importNovelFiles(paths: string[]): Promise<NovelDoc> {
  // 去重：同一文件选两次不重复拼接
  const uniquePaths = [...new Set(paths)].filter((p) => p);
  const done = log.time("chapters", `合并导入 ${uniquePaths.length} 个文件`);
  const parts: { path: string; fileName: string; text: string; encoding: string }[] = [];
  let totalChars = 0;
  for (const p of uniquePaths) {
    const { text, encoding } = await tauri.readTextFile(p);
    parts.push({ path: p, fileName: basename(p), text, encoding });
    totalChars += text.length;
  }
  const nonEmpty = parts.filter((p) => p.text.trim());
  if (nonEmpty.length === 0) {
    throw new Error("所选文件均为空，无法导入");
  }
  // B12：与 joinAppendText 共用同一归一化函数，分隔统一为 \n\n（各部分已折叠 3+ 换行），
  // 保证「追加拼接」与「重启后重新导入」得到同一 fullText（指纹一致，不误触重分章）
  const fullText = nonEmpty
    .map((p) => normalizeNovelText(p.text))
    .filter(Boolean)
    .join("\n\n");
  const fileName = parts.length === 1 ? parts[0].fileName : `${parts.length} 个文件合并`;
  const baseTitle = basenameWithoutExt(nonEmpty[0].path);
  // 合并导入不切章：仅作为单一章节占位，运行时分章阶段会替换
  const chapters: ChapterInfo[] = [
    { index: 0, title: baseTitle || "全文", text: fullText, charCount: fullText.length },
  ];
  log.info("chapters", "多文件合并导入完成", {
    fileCount: parts.length,
    fileNames: parts.map((p) => p.fileName),
    encoding: parts.map((p) => p.encoding),
    charCount: totalChars,
    mergedCharCount: fullText.length,
    skippedEmpty: parts.length - nonEmpty.length,
  });
  done(`文件=${parts.length} 字数=${fullText.length}`);
  return {
    fileName,
    sourcePath: nonEmpty[0].path,
    sourcePaths: uniquePaths,
    encoding: nonEmpty[0].encoding,
    fullText,
    chapters,
  };
}

export function cleanChapterText(chapter: ChapterInfo): string {
  return chapter.text.replace(/\r/g, "");
}
