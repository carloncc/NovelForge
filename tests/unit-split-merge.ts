import { mergeTinyChapters, protectSpecialBlocks, protectNumberedBlocks, MIN_CHAPTER_CHARS, splitChaptersForFallback } from "../src/core/split";
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
    const { chapters, merged } = mergeTinyChapters([ch(0, "作者的话", 500), ch(1, "第一章", 20000)]);
    assert(merged === 1 && chapters.length === 1, "首章碎章应合并");
    assert(chapters[0].title === "第一章", "应保留后一章标题");
  }

  // 真章节（编号章）即使很短也不合并（用户实测：22/23 章被误并入 21 章）
  {
    const r = mergeTinyChapters([ch(0, "20.哥布林杀手的微小荣光", 7938), ch(1, "21.一线之隔的天真", 16007), ch(2, "22.献给你", 1200), ch(3, "23.序幕", 900)]);
    assert(r.merged === 0 && r.chapters.length === 4, "编号真章节不应被碎章合并");
  }

  // 序/楔子等主线标记同样不合并
  {
    const r = mergeTinyChapters([ch(0, "楔子", 500), ch(1, "第一章", 20000)]);
    assert(r.merged === 0 && r.chapters.length === 2, "楔子属于主线章节，不应并入第一章");
  }

  // 机械回退标题「第N部分」不算真章节：短尾章应并入前一章（修复 295 字残段独立成章）
  {
    const r = mergeTinyChapters([ch(0, "第1部分", 20000), ch(1, "第2部分", 20000), ch(2, "第3部分", 295)]);
    assert(r.merged === 1 && r.chapters.length === 2, `机械碎章应合并，实际 merged=${r.merged} len=${r.chapters.length}`);
    assert(r.chapters[1].title === "第2部分", "应保留前一章标题");
    assert(r.chapters[1].text.length === 20295 + 2, `295 字残段应并入前一章，实际 ${r.chapters[1].text.length}`);
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

  // 编号真章节保护（始终生效）：被 LLM 标成杂项的编号章必须救回并立章
  {
    const blocks = ["第一章 正文", "22.献给你\n正文", "1、节选\n正文", "广告关注公众号", "序章\n正文"];
    const discard = new Set([2, 3, 4, 5]);
    const marks: { blockIndex: number; raw: string }[] = [{ blockIndex: 1, raw: "第一章" }];
    const kept = protectNumberedBlocks(blocks, discard, marks);
    assert(kept === 3, `应救回 3 个编号章，实际 ${kept}`);
    assert(!discard.has(2) && !discard.has(3) && !discard.has(5), "编号/序章块应移出丢弃集");
    assert(discard.has(4), "普通杂项应保留在丢弃集");
    assert(marks.some((m) => m.blockIndex === 2 && m.raw.startsWith("22.")), "救回的块应就地立章");
    for (let i = 1; i < marks.length; i++) assert(marks[i].blockIndex > marks[i - 1].blockIndex, "marks 应保持有序");
  }

  // #1137：首章前正文（前言/引子）不得丢弃，并入第一章开头
  {
    const text = "前言：这是一段引子，交代背景。\n\n第一章 初入江湖\n正文开始。\n\n第二章 再会\n继续。";
    const chapters = splitChaptersForFallback(text);
    assert(chapters.length === 2, `应切出 2 章，实际 ${chapters.length}`);
    assert(chapters[0].text.includes("前言：这是一段引子"), "首章前正文应并入第一章");
    assert(chapters[0].text.includes("正文开始"), "第一章正文应保留");
  }

  // #1137：长标题（分隔符后 15 字、含 ，）应识别为标题
  {
    const text = "第一章 出发\n正文。\n\n第十二章 少年自远方来，风尘仆仆归故里\n继续。";
    const chapters = splitChaptersForFallback(text);
    assert(chapters.length === 2, `长标题应识别，实际 ${chapters.length} 章`);
    assert(chapters[1].title.includes("第十二章"), `第二章标题应为长标题，实际 ${chapters[1].title}`);
  }

  // #1137：行首序号前缀（`1.`/`001 `）后接标题应识别；纯序号正文行不应误判
  {
    const text = "1. 第一章 标题\n正文开始。\n\n001 第二章 标题\n继续。\n\n1. 苹果很好吃\n买水果。";
    const chapters = splitChaptersForFallback(text);
    assert(chapters.length === 2, `序号前缀标题应识别，实际 ${chapters.length} 章`);
    assert(chapters[0].title === "1. 第一章 标题", `标题原文应保留，实际 ${chapters[0].title}`);
    assert(chapters[1].text.includes("苹果很好吃"), "序号正文行应留在章内，不另起章");
  }

  // #1137：英文标题（`Chapter 1 …`）应识别
  {
    const text = "Chapter 1 The Beginning\nBody text.\n\nChapter 2 The Journey\nMore body.";
    const chapters = splitChaptersForFallback(text);
    assert(chapters.length === 2, `英文标题应识别，实际 ${chapters.length} 章`);
  }

  console.log("=== split merge tests passed ===");
}

main();
