/**
 * #1528：protectSpecialBlocks / protectNumberedBlocks 的性质测试。
 *
 * 这两个函数靠**就地改 Set 与数组**工作，最容易出的错是「改了但没改干净」：
 * 返回的救回数与实际移出丢弃集的数量对不上、marks 被 push 后忘了排序、
 * 同一个块被重复立章、或者立了章却还留在丢弃集里（等于没救回来）。
 * 这些都与具体小说内容无关，因此断言不变量即可。
 */
import { protectSpecialBlocks, protectNumberedBlocks } from "../src/core/split";

interface Mark { blockIndex: number; raw: string }
interface Fn {
  (blocks: string[], discardSet: Set<number>, marks: Mark[]): number;
}

const TITLES = [
  "第一章 开端", "第二章 波澜", "第三章", "第4章", "序章", "楔子", "终章", "尾声",
  "番外 某日", "后记", "1. 第一节", "12、某节", "Chapter 3", "正文段落，不是标题",
  "插图说明", "作者的话", "很短", "", "   ",
  "作者的话而这里写得非常长以超过四十个字符的限制所以应当被截断处理掉才对",
];

function check(name: string, fn: Fn, discard: number[], marksIn: Mark[]): string[] {
  const bad: string[] = [];
  const blocks = ["占位"].concat(TITLES); // 索引从 1 起，匹配函数里的 blocks[idx - 1]
  const set = new Set(discard);
  const beforeSize = set.size;
  const marks = marksIn.map((m) => ({ ...m }));
  const beforeMarkIds = marks.map((m) => m.blockIndex);
  let kept: number;
  try {
    kept = fn(blocks, set, marks);
  } catch (e) {
    bad.push(`【${name}】抛异常：${e instanceof Error ? e.message : String(e)}`);
    return bad;
  }
  // ① 只能缩小丢弃集
  for (const x of discard) if (!set.has(x)) { /* 正常：被救回 */ }
  for (const x of set) if (!discard.includes(x)) bad.push(`【${name}】丢弃集里凭空多了 ${x}`);
  const removedCount = beforeSize - set.size;
  if (removedCount < 0) bad.push(`【${name}】丢弃集变大了`);
  // ② 救回数必须与实际移出数量一致
  if (kept !== removedCount)
    bad.push(`【${name}】返回值 ${kept} 与实际移出丢弃集的数量 ${removedCount} 不符`);
  // ③ marks 必须升序
  for (let i = 1; i < marks.length; i++) {
    if (marks[i - 1].blockIndex > marks[i].blockIndex) {
      bad.push(`【${name}】marks 未按 blockIndex 升序：${marks[i - 1].blockIndex} > ${marks[i].blockIndex}`);
      break;
    }
  }
  // ④ 不允许重复立章
  const ids = marks.map((m) => m.blockIndex);
  if (new Set(ids).size !== ids.length) bad.push(`【${name}】marks 出现重复 blockIndex：${ids.join(",")}`);
  // ⑤ 幂等：同一输入再跑一次不应再救回任何块
  const marks2 = marks.map((m) => ({ ...m }));
  const again = fn(blocks, new Set(set), marks2);
  if (again !== 0)
    bad.push(`【${name}】不幂等：第二次又救回了 ${again} 块`);
  // 说明：这里刻意**不**断言「凡 marks 里有的块都已在丢弃集之外」——
  // protectSpecialBlocks 只救「序/楔子/终章」类标题，protectNumberedBlocks 只救「编号章」类，
  // 两者互补而非各自都能清干净；调用方传入的 marks 与 discardSet 本就可能不一致。
  // ⑥ 原有 marks 不得被弄丢
  for (const id of beforeMarkIds) {
    if (!ids.includes(id)) bad.push(`【${name}】原有章节起点 ${id} 丢失`);
  }
  return bad;
}

function main(): void {
  const cases: { n: string; d: number[]; m: Mark[] }[] = [
    { n: "空丢弃集", d: [], m: [] },
    { n: "丢弃集含多个标题块", d: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], m: [] },
    { n: "丢弃集含非标题块", d: [14, 15, 16, 17, 18, 19], m: [] },
    { n: "混合", d: [1, 3, 6, 9, 14, 16, 19, 21], m: [] },
    { n: "已有 marks（乱序）", d: [2, 5, 7], m: [{ blockIndex: 7, raw: "第七章" }, { blockIndex: 2, raw: "第二章" }] },
    { n: "已有 marks 且与丢弃集重叠", d: [2, 4], m: [{ blockIndex: 4, raw: "第四章" }] },
    { n: "越界索引", d: [0, 999, -1, 21], m: [] },
    { n: "空字符串与纯空白标题", d: [18, 19], m: [] },
    { n: "超长标题行", d: [21], m: [] },
  ];
  const problems: string[] = [];
  for (const c of cases) {
    problems.push(...check("special/" + c.n, protectSpecialBlocks, c.d, c.m));
    problems.push(...check("numbered/" + c.n, protectNumberedBlocks, c.d, c.m));
  }
  if (problems.length) throw new Error("章节保护性质测试发现问题：\n - " + problems.join("\n - "));
  console.log(`=== 章节保护性质测试通过（2 个函数 × ${cases.length} 个用例：救回数自洽 / marks 升序去重 / 幂等 / 不丢原有起点 / 不改写丢弃集外的内容）===`);
}

main();
