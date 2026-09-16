/**
 * 章节范围文案（chapterScopeText）：确认框/日志必须与实际执行范围一致。
 *
 * 回归背景：单阶段「图像 / 配音」重跑会隐式继承全局章节勾选，而确认框写死「全书」，
 * 于是只勾了 2 章的用户被告知「将重画全书图片」，实际只跑那 2 章——计费承诺与执行不符。
 */
import { chapterScopeText } from "../src/core/visualBibleWorkflow";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function eq(actual: string, expected: string, label: string): void {
  assert(actual === expected, `${label}：期望「${expected}」，实际「${actual}」`);
}

function main(): void {
  // 1) 未限定范围 = 全部章节，措辞由调用点决定
  eq(chapterScopeText(null), "全书", "null → 全书（默认措辞）");
  eq(chapterScopeText(undefined), "全书", "undefined → 全书（默认措辞）");
  eq(chapterScopeText(null, "全部"), "全部", "自定义措辞");
  eq(chapterScopeText(undefined, "全部"), "全部", "undefined + 自定义措辞");

  // 2) 勾选了部分章节 = 只跑这些章节（1-based 展示，且按序号排序）
  eq(chapterScopeText([1]), "仅第 2 章", "单章");
  eq(chapterScopeText([1, 4]), "仅第 2、5 章", "多章");
  eq(chapterScopeText([4, 1]), "仅第 2、5 章", "乱序输入按序号排序");
  eq(chapterScopeText([0]), "仅第 1 章", "第 1 章边界");
  eq(chapterScopeText([11, 2]), "仅第 3、12 章", "两位数序号排序正确");

  // 3) 一个都没勾 = 必须明说「未选任何章节」，不能谎报「全书」
  eq(chapterScopeText([]), "未选任何章节", "空数组不得回退成全书");
  eq(chapterScopeText([], "全部"), "未选任何章节", "空数组忽略自定义措辞");

  // 4) 不得就地修改调用方的数组（传入的是 store 里的活数组）
  const input = [4, 1];
  chapterScopeText(input);
  assert(JSON.stringify(input) === "[4,1]", "不得就地排序调用方的数组");

  console.log("=== 章节范围文案测试通过 ===");
}

main();
