import type { ChapterInfo, NovelDoc } from "./types";
import { tauri } from "../utils/tauri";
import { basename, basenameWithoutExt } from "../utils/path";
import { log } from "../utils/logger";

const CHAPTER_RE =
  /^\s*(第[零〇一二三四五六七八九十百千万两\d]+[章节回卷部集幕篇](?:[\s·：:－—-][^。！？!?；;\n]{1,12})?|(?:序章|序言|楔子|尾声|终章|番外|后记|前言|引子)(?:[\s·：:－—-][^。！？!?；;\n]{1,12})?)\s*$/;

function isChapterTitle(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length > 40 || trimmed.length < 2) return false;
  if (CHAPTER_RE.test(trimmed)) return true;
  if (/^(Chapter|CHAPTER|Episode|episode|Prologue|Epilogue|Act)\s*\d*.*$/i.test(trimmed) && trimmed.length <= 40) return true;
  return false;
}

export function splitChapters(fullText: string, baseTitle: string): ChapterInfo[] {
  const lines = fullText.split(/\r?\n/);
  const chapters: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } = { title: "第一章", lines: [] };
  let anyChapter = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (isChapterTitle(line)) {
      current = { title: line.trim(), lines: [] };
      chapters.push(current);
      anyChapter = true;
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

export interface ChapterAdjust {
  chapterIndex: number;
  newTitle: string;
}

export async function importNovelFile(path: string): Promise<NovelDoc> {
  const done = log.time("chapters", `导入小说 ${path}`);
  const { text, encoding } = await tauri.readTextFile(path);
  const fileName = basename(path);
  const baseTitle = basenameWithoutExt(path);
  const chapters = splitChapters(text, baseTitle);
  log.info("chapters", "小说导入完成", {
    path,
    fileName,
    encoding,
    charCount: text.length,
    chapterCount: chapters.length,
    chapterTitles: chapters.map((c) => c.title),
  });
  done(`章节=${chapters.length} 字数=${text.length}`);
  return {
    fileName,
    sourcePath: path,
    sourcePaths: [path],
    encoding,
    fullText: text,
    chapters,
  };
}

/**
 * 多文件合并导入：把所有 txt 按顺序拼接为一部小说，导入时不切章。
 * 章节划分留到「分章」阶段（运行管线时由 AI 完成）。
 */
export async function importNovelFiles(paths: string[]): Promise<NovelDoc> {
  const done = log.time("chapters", `合并导入 ${paths.length} 个文件`);
  const parts: { path: string; fileName: string; text: string; encoding: string }[] = [];
  let totalChars = 0;
  for (const p of paths) {
    const { text, encoding } = await tauri.readTextFile(p);
    parts.push({ path: p, fileName: basename(p), text, encoding });
    totalChars += text.length;
  }
  const fullText = parts
    .map((p) => p.text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim())
    .filter(Boolean)
    .join("\n\n\n");
  const fileName = parts.length === 1 ? parts[0].fileName : `${parts.length} 个文件合并`;
  const baseTitle = basenameWithoutExt(parts[0].path);
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
  });
  done(`文件=${parts.length} 字数=${fullText.length}`);
  return {
    fileName,
    sourcePath: parts[0].path,
    sourcePaths: paths,
    encoding: parts[0].encoding,
    fullText,
    chapters,
  };
}

export function cleanChapterText(chapter: ChapterInfo): string {
  return chapter.text.replace(/\r/g, "");
}
