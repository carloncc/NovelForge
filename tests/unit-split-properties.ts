/**
 * #1527：分章产出的内部一致性（性质测试，非逐例快照）。
 *
 * 本文件测三条对任意输入都应成立的性质，而不是把每个用例的结果写死：
 * ① 不抛异常，且总能产出至少一章；
 * ② 章节 index 从 0 连续编号；
 * ③ **charCount === text.length** —— 这正是 #1527 破坏的那条：纯空白原文曾得到
 *    「text 为空、charCount 却记着空白字数」，导入页字数列与按字数的预算都会算多；
 * ④ 无章节标记时正文必须原样保留（回退路径不得吞正文）。
 */
import { splitChaptersForFallback } from "../src/core/split";
import { splitChapters } from "../src/core/chapters";

const dense = (s: string): string => s.replace(/\s+/g, "");

interface Case { name: string; text: string; }
const CASES: Case[] = [
  { name: "普通两章", text: "第一章 初入\n\n正文一。\n\n第二章 再会\n\n正文二。" },
  { name: "无章节标题", text: "只有正文，没有任何章节标记。\n还是正文。" },
  { name: "前言在首章之前", text: "内容简介：这是一本小说。\n\n第一章 起点\n\n正文。" },
  { name: "连续两个标题（空章）", text: "第一章 A\n第二章 B\n正文。" },
  { name: "标题在末行（尾章为空）", text: "第一章 A\n正文。\n第二章 B" },
  { name: "CRLF 换行", text: "第一章 A\r\n\r\n正文。\r\n\r\n第二章 B\r\n\r\n正文二。" },
  { name: "带 BOM", text: "\uFEFF第一章 A\n\n正文。" },
  { name: "带序号前缀", text: "1. 第一章 A\n\n正文。\n\n2、第二章 B\n\n正文二。" },
  { name: "标题超长(>60)", text: "第一章 " + "长".repeat(80) + "\n\n正文。" },
  { name: "只有标题无正文", text: "第一章 A" },
  { name: "空字符串", text: "" },
  { name: "纯空白", text: "   \n\n  \t " },
  { name: "纯换行", text: "\n\n\n" },
  { name: "单字符", text: "a" },
  { name: "英文标题", text: "Chapter 1 The Start\n\nBody one.\n\nChapter 2 Next\n\nBody two." },
  { name: "数字章号", text: "第1章\n\n正文一。\n\n第2章\n\n正文二。" },
  { name: "多空行", text: "第一章 A\n\n\n\n\n正文。" },
];

function check(name: string, out: ReturnType<typeof splitChaptersForFallback>, source: string): string[] {
  const bad: string[] = [];
  if (!Array.isArray(out) || out.length === 0) { bad.push(`【${name}】未产出任何章节`); return bad; }
  out.forEach((ch, i) => {
    if (ch.index !== i) bad.push(`【${name}】index 不连续：第 ${i} 章 index=${ch.index}`);
    if (ch.charCount !== ch.text.length)
      bad.push(`【${name}】第 ${i} 章 charCount(${ch.charCount}) ≠ text.length(${ch.text.length})（#1527）`);
  });
  // ④ 不得产出「空章」——没有正文的章节流到下游会白烧 token、生成空场景。
  //    唯一例外：整个输入就是空白（此时只应有 1 章回退章，见 merged.length === 0 分支）。
  //    （变异测试发现：split.ts / chapters.ts 的 `if (!text) continue;` 删掉后整套测试全绿）
  const blanks = out.filter((c) => c.charCount === 0);
  if (blanks.length > 0) {
    const wholeInputBlank = dense(source) === "";
    if (!wholeInputBlank)
      bad.push(`【${name}】产出 ${blanks.length} 个空章：${blanks.map((c) => c.title).join("、")}（应整章丢弃）`);
    else if (out.length !== 1)
      bad.push(`【${name}】全空白输入应只产出 1 章回退章，实得 ${out.length} 章`);
  }
  // 无章节标记时，正文必须原样保留
  if (!/第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章节回卷部集幕篇]|序章|序言|楔子|尾声|终章|番外|后记|前言|引子|chapter|episode|prologue|epilogue|act/i.test(source)) {
    if (dense(source) !== dense(out.map((c) => c.text).join("")))
      bad.push(`【${name}】无章节标记时正文被改动：原文 ${dense(source).length} 字 / 产出 ${dense(out.map((c) => c.text).join("")).length} 字`);
  }
  return bad;
}

function main(): void {
  const problems: string[] = [];
  for (const c of CASES) {
    let out;
    try {
      out = splitChaptersForFallback(c.text);
    } catch (e) {
      problems.push(`【${c.name}】抛异常：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    problems.push(...check(c.name, out, c.text));
  }

  // chapters.ts 里那处同款回退（#1527 一并修的）也必须自洽
  // ① 纯空白输入：只应有 1 章回退章（#1527 修的就是这条路径的 charCount）
  const blankOut = splitChapters("   \n\n  \t ", "a");
  if (blankOut.length !== 1)
    problems.push(`【chapters.ts 纯空白输入】应只产出 1 章回退章，实得 ${blankOut.length} 章（#1529）`);
  // ② 既有空章又有正文章：空的那章必须整章丢掉——
  //    删掉 chapters.ts 的 `if (!text) continue;` 整套测试原本全绿（变异测试发现）
  const withEmpty = splitChapters("第一章 A\n第二章 B\n正文。", "base");
  const empties = withEmpty.filter((c) => c.charCount === 0);
  if (empties.length > 0)
    problems.push(`【chapters.ts 含空章】产出 ${empties.length} 个空章：${empties.map((c) => c.title).join("、")}（应整章丢弃，#1529）`);
  const fromParts = withEmpty;
  fromParts.forEach((ch, i) => {
    if (ch.charCount !== ch.text.length)
      problems.push(`【chapters.ts 纯空白回退】charCount(${ch.charCount}) ≠ text.length(${ch.text.length})（#1527）`);
    if (ch.index !== i) problems.push(`【chapters.ts 纯空白回退】index 不连续`);
    if (ch.charCount === 0 && fromParts.length !== 1)
      problems.push(`【chapters.ts 纯空白回退】产出 ${fromParts.length} 章（含空章），应只留 1 章（#1529）`);
  });

  if (problems.length) throw new Error("分章性质测试发现问题：\n - " + problems.join("\n - "));
  console.log(`=== 分章性质测试通过（${CASES.length} 个用例 + chapters.ts：charCount≡text.length / index 连续 / 无空章 / 正文不丢）===`);
}

main();
