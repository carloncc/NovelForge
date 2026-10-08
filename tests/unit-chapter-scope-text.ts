/**
 * #1559：章节范围文案的契约。
 *
 * 这不是一句普通的 UI 文案：阶段重跑会**隐式继承全局章节勾选**，确认框写错范围等于
 * 「对用户计费范围的假承诺」（该函数注释原话）。而这一带的索引口径很容易搞混——
 * 全仓约定如下，本测试把最后一步（显示）钉住：
 *
 *   types.ts:566-575   各 rerun/force 字段一律是 **novel index（0-based）**
 *   pipeline.ts        chapterPositions() 负责 novel index → chapters 数组位置
 *   generate.ts:2487   失败项 id `chapter_N`（**1-based**）→ N-1 得 novel index
 *   chapterScopeText   显示时 +1 回到 1-based 给用户看
 *
 * 即：每个边界只换算一次。任何一处多减/多加 1，用户看到的章节号就与实际重跑（计费）的不符。
 */
import { chapterScopeText } from "../src/core/visualBibleWorkflow";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main(): void {
  // ① null / undefined = 全部（措辞由调用点传入，因为各处口径不同）
  assert(chapterScopeText(null) === "全书", "null 应显示默认的「全书」（#1559）");
  assert(chapterScopeText(undefined) === "全书", "undefined 同上（#1559）");
  assert(chapterScopeText(null, "全部") === "全部", "allLabel 应由调用点决定（#1559）");

  // ② 空数组 ≠ 全部：必须是「未选任何章节」，否则会把「一章都不跑」说成「全书」
  assert(chapterScopeText([]) === "未选任何章节", "空数组必须与全部区分开（#1559）");
  assert(chapterScopeText([]) !== chapterScopeText(null), "「未选」与「全部」绝不能同文案（#1559）");

  // ③ 0-based → 1-based 显示
  assert(chapterScopeText([0]) === "仅第 1 章", "novel index 0 应显示第 1 章，实际 " + chapterScopeText([0]) + "（#1559）");
  assert(chapterScopeText([9]) === "仅第 10 章", "novel index 9 应显示第 10 章（#1559）");

  // ④ 排序 + 不重复消费顺序（乱序输入要按章号升序显示，否则用户难以核对）
  assert(chapterScopeText([2, 0, 1]) === "仅第 1、2、3 章", "应按章号升序，实际 " + chapterScopeText([2, 0, 1]) + "（#1559）");

  // ⑤ 不得改写传入数组（调用方还会继续用它做实际范围）
  const src = [3, 1];
  chapterScopeText(src);
  assert(src[0] === 3 && src[1] === 1, "不得就地排序传入数组（会改变实际执行范围）（#1559）");

  console.log("=== 章节范围文案契约通过（#1559：0-based 内部 / 1-based 显示，空≠全部）===");
}

main();
