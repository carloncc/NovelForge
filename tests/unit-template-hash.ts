/**
 * #1127：主题哈希选择器校验（构建可见、警告不阻断）。
 * hashClassSelectorsOf 提取 CSS Modules 编译哈希类名；
 * missingEngineClasses 找出引擎产物中已不存在的选择器。
 */
import { hashClassSelectorsOf, missingEngineClasses } from "../scripts/check-template.mjs";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function main(): void {
  const css = [
    "._main_rdjpk_1 { color: red; }",
    "._fastSlPreview_rdjpk_59 { display: none; }",
    ".title-enter { color: blue; }",
    ".TextBox_main { color: green; }",
    "._main_rdjpk_1 { color: red; }",
  ].join("\n");
  const selectors = hashClassSelectorsOf(css);
  assert(selectors.length === 2, `应提取 2 个哈希类名，实际 ${selectors.length}: ${selectors}`);
  assert(selectors.includes("_main_rdjpk_1"), "缺少 _main_rdjpk_1");
  assert(selectors.includes("_fastSlPreview_rdjpk_59"), "缺少 _fastSlPreview_rdjpk_59");
  assert(!selectors.includes("title-enter"), "稳定类名不应被当成哈希选择器");

  // 引擎升级后部分类名消失 → 只报缺失的
  const engineText = "._main_rdjpk_1{color:red} index-abc.js body";
  const missing = missingEngineClasses(selectors, engineText);
  assert(missing.length === 1 && missing[0] === "_fastSlPreview_rdjpk_59", `缺失清单错误: ${missing}`);

  // 全部存在 → 无警告
  assert(missingEngineClasses(selectors, selectors.join(" ")).length === 0, "全存在时不应报缺失");

  console.log("=== 主题哈希校验（#1127）测试通过 ===");
}

try {
  main();
} catch (e) {
  console.error("失败:", e);
  process.exit(1);
}
