/**
 * #1570：边缘去色溢的背景估计**不得在无样本时给出 NaN**。
 *
 * cutout/despill.ts 的 median 没有空数组保护：`sorted.length % 2` 对 0 为假，走偶数分支
 * `(sorted[-1] + sorted[0]) / 2` = `(undefined + undefined) / 2` = **NaN**。
 * （对照：faceComposite.ts 的同名 median 有 `if (!values.length) return 0;`，两份实现只有这一点不同。）
 *
 * 原实现只有 `if (rs.length < minSamples) return null;`，而 minSamples 可被 DespillOpts 覆盖。
 * 若传 0，则「全透明图」（所有像素都过不了 alpha 过滤）会让 rs 为空并走到 median([])：
 * 拿到 NaN → 后面的 `NaN > maxMAD` 为假（NaN 与任何数比较都是 false）→ 判不出「背景不均匀」
 * → 把 [NaN, NaN, NaN] 当背景色返回。修法是显式判空：无样本 = 估不出背景 = 跳过。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 复刻 despill 的 median（用于演示空数组行为），以及 faceComposite 的同名实现对照 */
function despillMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function faceMedian(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function main(): void {
  // ① 复现：despill 的 median 对空数组给出 NaN（这就是本缺陷的根）
  assert(Number.isNaN(despillMedian([])),
    "前置条件：despill 的 median 对空数组应给出 NaN（若这条不成立，说明 median 已被加上保护，本测试需重写）（#1570）");
  // 对照：faceComposite 同名实现给出 0
  assert(faceMedian([]) === 0, "对照：faceComposite 的 median 对空数组返回 0（#1570）");

  // ② NaN 会绕过「背景不均匀」判定——这正是危险之处
  const maxMAD = 28;
  assert(!(Number.NaN > maxMAD), "NaN 与阈值比较恒为 false，因此 meanMAD=NaN 时判不出「背景不均匀」（#1570）");

  // ③ 非空输入下两者必须一致（不能因为加守卫改变正常行为）
  const sets = [[5], [5, 9], [1, 2, 3], [1, 2, 3, 4], [10, 10, 10, 10]];
  for (const s of sets) {
    assert(despillMedian(s) === faceMedian(s),
      "非空输入下两个 median 必须一致，输入 " + JSON.stringify(s) + "：despill=" + despillMedian(s) + " face=" + faceMedian(s) + "（#1570）");
  }

  // ④ 源码契约：空样本必须在进 median 之前被挡住
  const SRC = readFileSync(join(process.cwd(), "src", "core", "cutout", "despill.ts"), "utf8");
  assert(/if \(!rs\.length \|\| rs\.length < minSamples\) return null;/.test(SRC),
    "despill 必须在 minSamples 判定里先判空（否则 minSamples=0 时会用 NaN 当背景色）（#1570）");

  console.log("=== 去色溢背景估计的空样本守卫通过（#1570：不再可能返回 NaN 背景色）===");
}

main();
