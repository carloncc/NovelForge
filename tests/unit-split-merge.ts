import { mergeTinyChapters, protectSpecialBlocks, MIN_CHAPTER_CHARS } from "../src/core/split";
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

  // 阈值 0 = 关闭合并（特殊小章独立成章，配合 keepSpecials 找回 26 章）
  {
    const r = mergeTinyChapters([ch(0, "第一章", 20000), ch(1, "后记", 1185), ch(2, "插图", 300)], 0);
    assert(r.merged === 0 && r.chapters.length === 3, "阈值 0 不应合并");
  }

  // 特殊章节保护：被标丢弃的后记/插图/特典移出丢弃集并立章；普通杂项不动；已立章不重复
  {
    const blocks = ["第一章正文很长很长", "后记\n感谢看到这里的读者", "广告关注公众号", "特典 小剧场\n正文", "第一章 第二节\n正文继续"];
    const discard = new Set([2, 3, 4]);
    const marks: { blockIndex: number; raw: string }[] = [{ blockIndex: 1, raw: "第一章" }, { blockIndex: 5, raw: "第一节" }];
    const kept = protectSpecialBlocks(blocks, discard, marks);
    assert(kept === 2, `应救回 2 个特殊章，实际 ${kept}`);
    assert(!discard.has(2) && !discard.has(4) && discard.has(3), "普通杂项应保留在丢弃集");
    assert(marks.some((m) => m.blockIndex === 2 && m.raw === "后记"), "后记应就地立章");
    assert(marks.some((m) => m.blockIndex === 4), "特典应就地立章");
    assert(marks.filter((m) => m.blockIndex === 5).length === 1, "已立章不应重复");
    for (let i = 1; i < marks.length; i++) assert(marks[i].blockIndex > marks[i - 1].blockIndex, "marks 应保持有序");
  }

  // 非特殊首行不救
  {
    const discard = new Set([1]);
    const marks: { blockIndex: number; raw: string }[] = [];
    assert(protectSpecialBlocks(["第一章正文"], discard, marks) === 0, "普通块不应被救");
    assert(discard.has(1), "普通块应留在丢弃集");
  }

  console.log("=== split merge tests passed ===");
}

main();
