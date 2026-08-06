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
    encoding,
    fullText: text,
    chapters,
  };
}

export function cleanChapterText(chapter: ChapterInfo): string {
  return chapter.text.replace(/\r/g, "");
}
