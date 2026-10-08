/**
 * #1560：`appendSafeStyleSuffix` 必须幂等。
 *
 * images.ts 的内容审查改写阶梯在第 1 阶与第 2 阶各调它一次（未配置安全改写 LLM 时
 * 两阶都走「追加后缀」兜底）。原实现无条件追加，于是同一段安全后缀被写两遍，
 * 而**第 2 阶那次是白烧钱的付费重试**——请求与第 1 阶只差一段重复样板，注定同样被拒。
 * 该阶梯自己的注释写的是「不再白烧钱」，所以这是与设计意图相反的行为。
 */
import { appendSafeStyleSuffix } from "../src/utils/promptRewriter";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const SAFE = "anime style, wholesome, suitable for all audiences, family friendly, no explicit content";

function countOccurrences(hay: string, needle: string): number {
  let n = 0, i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at < 0) return n;
    n++;
    i = at + needle.length;
  }
}

function main(): void {
  // ① 首次追加：必须真的加上
  const once = appendSafeStyleSuffix("a warrior on a wall");
  assert(once.includes(SAFE), "首次调用必须追加安全后缀（#1560）");
  assert(countOccurrences(once, SAFE) === 1, "首次调用只应出现一次后缀（#1560）");

  // ② 幂等：第二次、第三次调用都不得再追加（这正是阶梯第 2 阶的路径）
  const twice = appendSafeStyleSuffix(once);
  assert(twice === once, "第二次调用必须原样返回（幂等），实际多加了内容：" + JSON.stringify(twice.slice(-60)) + "（#1560）");
  assert(countOccurrences(twice, SAFE) === 1, "后缀不得出现两次（#1560）");
  assert(appendSafeStyleSuffix(twice) === once, "第三次调用同样必须幂等（#1560）");

  // ③ 句号结尾与逗号结尾两条分支都要幂等
  const dotted = appendSafeStyleSuffix("a warrior on a wall.");
  assert(dotted.endsWith("."), "句号结尾分支应保持句号结尾（#1560）");
  assert(appendSafeStyleSuffix(dotted) === dotted, "句号分支也必须幂等（#1560）");

  // ④ 不含后缀的输入仍要正常追加（别把幂等写成「一律返回原样」）
  const fresh = appendSafeStyleSuffix("two warriors, night city wall, dramatic light");
  assert(fresh.includes(SAFE), "不含后缀的输入仍须追加（#1560）");
  assert(fresh !== "two warriors, night city wall, dramatic light", "不得退化成恒等函数（#1560）");

  console.log("=== 安全后缀幂等性测试通过（#1560：阶梯第 2 阶不再白烧一次付费重试）===");
}

main();
