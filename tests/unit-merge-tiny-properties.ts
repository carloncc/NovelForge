/**
 * #1528：碎章合并 mergeTinyChapters 的性质测试。
 *
 * 该函数只做「把相邻章节正文首尾相接」，因此有两条很强的、不依赖具体输出形状的不变量：
 * ① 正文与顺序**逐字不变**——合并前后各章正文拼起来去掉空白后必须完全相同；
 * ② charCount 必须随正文一起重算（与 #1527 同一条不变量）。
 *
 * 另外顺带守住：index 重编号连续、merged 计数与实际减少的章数相符、
 * 幂等（再跑一次不应继续合并）、入参不被就地改写。
 */
import { mergeTinyChapters, MIN_CHAPTER_CHARS } from "../src/core/split";
import type { ChapterInfo } from "../src/core/types";

const dense = (s: string): string => s.replace(/\s+/g, "");
const ch = (index: number, title: string, size: number): ChapterInfo => {
  // 每章带自己的标记：正文若被接错顺序，dense() 比较就能发现（用同一个字符重复就测不出来）
  const text = "[" + index + "]" + "字".repeat(Math.max(0, size - String(index).length - 2));
  return { index, title, text, charCount: text.length };
};

interface Case { name: string; input: ChapterInfo[]; min: number }
const CASES: Case[] = [
  { name: "空数组", input: [], min: MIN_CHAPTER_CHARS },
  { name: "单章", input: [ch(0, "第一章", 100)], min: 100 },
  { name: "全部达标", input: [ch(0, "第一章", 5000), ch(1, "第二章", 5000)], min: 3000 },
  { name: "尾章过短（无题碎片）", input: [ch(0, "第一章", 5000), ch(1, "片段", 10)], min: 3000 },
  { name: "首章过短（无题碎片）", input: [ch(0, "片段", 10), ch(1, "第二章", 5000)], min: 3000 },
  { name: "首尾都过短", input: [ch(0, "片段A", 5), ch(1, "片段B", 7), ch(2, "第三章", 5000)], min: 3000 },
  { name: "全是很短的碎片", input: [ch(0, "a", 1), ch(1, "b", 1), ch(2, "c", 1), ch(3, "d", 1)], min: 3000 },
  { name: "短编号真章不参与合并", input: [ch(0, "第一章", 5000), ch(1, "第二十二章", 10), ch(2, "第二十三章", 10)], min: 3000 },
  { name: "机械「第N部分」可被合并", input: [ch(0, "第一章", 5000), ch(1, "第2部分", 10)], min: 3000 },
  { name: "序章标题不合并", input: [ch(0, "序章", 10), ch(1, "第一章", 5000)], min: 3000 },
  { name: "连续碎片级联", input: [ch(0, "x", 5), ch(1, "y", 5), ch(2, "z", 5), ch(3, "尾", 5000)], min: 3000 },
  { name: "单章且过短", input: [ch(0, "片段", 3)], min: 3000 },
  { name: "minChars=0（全部达标）", input: [ch(0, "a", 0), ch(1, "b", 0)], min: 0 },
  { name: "序号前缀标题", input: [ch(0, "1. 某节", 5000), ch(1, "碎片", 10)], min: 3000 },
];

function main(): void {
  const problems: string[] = [];
  for (const c of CASES) {
    const before = JSON.stringify(c.input);
    let r;
    try {
      r = mergeTinyChapters(c.input, c.min);
    } catch (e) {
      problems.push(`【${c.name}】抛异常：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    // ① 正文与顺序逐字不变
    const want = dense(c.input.map((x) => x.text).join(""));
    const got = dense(r.chapters.map((x) => x.text).join(""));
    if (want !== got)
      problems.push(`【${c.name}】正文被改动：合并前 ${want.length} 字 / 合并后 ${got.length} 字`);
    // ② charCount 随正文重算
    r.chapters.forEach((x, i) => {
      if (x.charCount !== x.text.length)
        problems.push(`【${c.name}】第 ${i} 章 charCount(${x.charCount}) ≠ text.length(${x.text.length})（#1528）`);
      if (x.index !== i) problems.push(`【${c.name}】第 ${i} 章 index=${x.index}（未重编号）`);
    });
    // ③ merged 计数与实际减少的章数相符
    const dropped = c.input.length - r.chapters.length;
    if (r.merged !== dropped)
      problems.push(`【${c.name}】merged=${r.merged} 但实际少了 ${dropped} 章`);
    // ④ 幂等：再跑一次不应再合并
    const again = mergeTinyChapters(r.chapters, c.min);
    if (again.merged !== 0)
      problems.push(`【${c.name}】不幂等：第二次又合并了 ${again.merged} 章`);
    // ⑤ 入参不被就地改写
    if (JSON.stringify(c.input) !== before)
      problems.push(`【${c.name}】就地改写了入参`);
  }
  if (problems.length) throw new Error("碎章合并性质测试发现问题：\n - " + problems.join("\n - "));
  console.log(`=== 碎章合并性质测试通过（${CASES.length} 个用例：正文逐字不变 / charCount 自洽 / index 连续 / 幂等 / 不改入参）===`);
}

main();
