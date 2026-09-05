import { mergeTinyChapters, MIN_CHAPTER_CHARS } from "../src/core/split";
import type { ChapterInfo } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function ch(index: number, title: string, chars: number): ChapterInfo {
  return { index, title, text: "x".repeat(chars), charCount: chars };
}

function main(): void {
  assert(MIN_CHAPTER_CHARS > 0, "应有碎章阈值");

  // 尾部碎章（后记/插图）并入前一章
  {
    const { chapters, merged } = mergeTinyChapters([ch(0, "第一章", 20000), ch(1, "后记", 1185)]);
    assert(merged === 1, `应合并 1 个，实际 ${merged}`);
    assert(chapters.length === 1 && chapters[0].title === "第一章", "应保留前一章标题");
    assert(chapters[0].text.length === 21185 + 2, `正文应拼接，实际 ${chapters[0].text.length}`);
    assert(chapters[0].index === 0, "应重编号");
  }

  // 首章碎章并入后一章，保留后者标题
  {
    const { chapters, merged } = mergeTinyChapters([ch(0, "楔子", 500), ch(1, "第一章", 20000)]);
    assert(merged === 1 && chapters.length === 1, "首章碎章应合并");
    assert(chapters[0].title === "第一章", "应保留后一章标题");
  }

  // 中部碎章（插图）并入前一章
  {
    const r = mergeTinyChapters([ch(0, "第一章", 20000), ch(1, "插图", 1096), ch(2, "第二章", 20000)]);
    assert(r.merged === 1 && r.chapters.length === 2, "中部碎章应合并");
    assert(r.chapters[0].text.length === 21096 + 2, "应并入前一章");
    assert(r.chapters[1].title === "第二章" && r.chapters[1].index === 1, "后续章节应前移并重编号");
  }

  // 全达标不合并
  {
    const r = mergeTinyChapters([ch(0, "第一章", 20000), ch(1, "第二章", 20000)]);
    assert(r.merged === 0 && r.chapters.length === 2, "达标章节不应合并");
  }

  // 单章不合并（再短也保留，避免清空）
  {
    const r = mergeTinyChapters([ch(0, "全文", 500)]);
    assert(r.merged === 0 && r.chapters.length === 1, "单章不应合并");
  }

  // 自定义阈值
  {
    const r = mergeTinyChapters([ch(0, "第一章", 20000), ch(1, "短章", 4000)], 5000);
    assert(r.merged === 1 && r.chapters.length === 1, "自定义阈值应生效");
  }

  console.log("=== split merge tests passed ===");
}

main();
