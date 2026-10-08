/**
 * #1573：`skinMedianOffset` 的「无有效样本 → [0,0,0]」契约，以及**两份 median 不可互换**。
 *
 * 背景（接 #1570）：全仓有两个 `median` ——
 *   cutout/despill.ts:37   无空数组保护（依赖调用方的 minSamples 判定先挡掉空输入）
 *   faceComposite.ts:89    自带 `if (!values.length) return 0;`
 *
 * #1570 之后很容易产生「顺手把两个 median 合并成一份」的念头（本会话 #1568/#1569 就是干这个的）。
 * **但这里不能合**：`skinMedianOffset` 的文档明确写着「无有效样本返回 [0,0,0]」，而它恰恰依赖
 * faceComposite 那份的**空数组保护**——所有样本都被饱和度过滤掉时，diffs 为空，median([]) 必须给 0。
 * 若换成 despill 那份，就会得到 [NaN, NaN, NaN]，contracted 契约被破坏，NaN 还会顺着 skinOffset 污染合成。
 *
 * 本测试把这条契约钉住：**将来谁想统一这两个 median，会先撞到这个测试。**
 */
import { skinMedianOffset } from "../src/core/faceComposite";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Rgb = [number, number, number];

function main(): void {
  // ① 文档点名的契约：无有效样本 → [0,0,0]（不是 NaN）
  const empty = skinMedianOffset([], []);
  assert(empty.every((v) => v === 0), "无样本必须返回 [0,0,0]（文档明写），实际 " + JSON.stringify(empty) + "（#1573）");
  assert(empty.every((v) => Number.isFinite(v)), "不得返回 NaN/Infinity（#1573）");

  // ② 全部样本被饱和度过滤 → 同样要 [0,0,0]（这条走的正是 median([]) 的分支）
  const saturated: Rgb[] = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
  const allSkipped = skinMedianOffset(saturated, saturated);
  assert(allSkipped.every((v) => v === 0),
    "样本全被跳过时必须返回 [0,0,0]，实际 " + JSON.stringify(allSkipped) + "——若得到 NaN，说明 median 的空数组保护被拿掉了（#1573）");

  // ③ 正常路径仍要工作（别为了让②通过就把函数写死成返回 0）
  const clean: Rgb[] = [[10, 10, 10], [12, 12, 12], [14, 14, 14]];
  const cand: Rgb[] = [[0, 0, 0], [2, 2, 2], [4, 4, 4]];
  const off = skinMedianOffset(clean, cand);
  assert(off.every((v) => v === 10), "正常样本的中位差应为 [10,10,10]，实际 " + JSON.stringify(off) + "（#1573）");

  // ④ 长度不等时以较短者为准（:101 的 Math.min），不得越界或产生 NaN
  const skewed = skinMedianOffset(clean, [[0, 0, 0]]);
  assert(skewed.every((v) => Number.isFinite(v)), "长度不等时不得产生 NaN，实际 " + JSON.stringify(skewed) + "（#1573）");

  console.log("=== 肤色中位差契约通过（#1573：[0,0,0] 兜底依赖 median 的空数组保护，两份 median 不可合并）===");
}

main();
