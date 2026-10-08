/**
 * #1567：两个「由文本推情绪」的函数，**类别判定顺序必须一致**。
 *
 *   script.ts   emotionOf(text)      由台词文本推情绪，写在 line.emotion 上
 *   render.ts   emotionFromTag(text) 由动作标签推情绪，写进 pendingTag.emotion
 *
 * 两者都决定同一条台词最终用哪张表情差分图。关键词重叠时**顺序决定归属**：
 * 原实现 render 侧把 sad 排在最前、script 侧把 angry 排在最前，注释却写「同口径」——
 * 于是「既像生气又像叹气」的动作标签，在剧本期与渲染期会被判成不同情绪。
 *
 * 两个函数都是模块私有、无法直接单测，因此这里校验**源码契约**：
 * 从各自函数体里按出现顺序取出 return 的情绪字面量，断言两个序列一致。
 * 关键词集合允许不同（render 侧是超集，有意为之），**只钉顺序**。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 取某文件里从 startMarker 起、直到下一个顶层 '}' 的函数体 */
function bodyAfter(src: string, startMarker: string): string {
  const at = src.indexOf(startMarker);
  assert(at >= 0, "找不到标记：" + startMarker + "（#1567）");
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error("括号不闭合：" + startMarker + "（#1567）");
}

/** 按源码中出现顺序取出 return 的情绪字面量 */
function emotionOrder(body: string): string[] {
  return [...body.matchAll(/return\s+"(angry|happy|surprised|sad|normal)"/g)].map((m) => m[1]);
}

function main(): void {
  const script = readFileSync(join(process.cwd(), "src", "core", "script.ts"), "utf8");
  const render = readFileSync(join(process.cwd(), "src", "core", "render.ts"), "utf8");

  const scriptOrder = emotionOrder(bodyAfter(script, "function emotionOf("));
  const renderOrder = emotionOrder(bodyAfter(render, "function emotionFromTag("));

  // 前置条件：两个函数都真的取到了顺序（否则下面的相等断言可能是空跑）
  assert(scriptOrder.length >= 4, "未能从 emotionOf 取出足够多的情绪分支，实际 " + JSON.stringify(scriptOrder) + "（#1567）");
  assert(renderOrder.length >= 4, "未能从 emotionFromTag 取出足够多的情绪分支，实际 " + JSON.stringify(renderOrder) + "（#1567）");

  // ① 核心断言：**情绪类别的判定顺序**必须一致。
  //    script 侧末尾多一个 normal 兜底、render 侧以 undefined 表示未推断——
  //    这个默认值差异是有意的（单独在 ③ 里断言），所以比较前先滤掉 normal。
  const scriptCats = scriptOrder.filter((x) => x !== "normal");
  assert(
    renderOrder.join(">") === scriptCats.join(">"),
    "两个情绪推断函数的判定顺序必须一致（顺序在关键词重叠时决定归属）；" +
      "script=" + scriptCats.join(">") + " render=" + renderOrder.join(">") + "（#1567）",
  );

  // ② script 侧必须保留 normal 兜底（不能因为对齐顺序把它丢了）
  assert(scriptOrder.includes("normal"), "emotionOf 必须保留 normal 兜底（#1567）");

  // ③ render 侧应返回 undefined 表示「没有推断」（这是它与 script 侧有意的差异，别被顺手改成 normal）
  assert(/return undefined;/.test(bodyAfter(render, "function emotionFromTag(")),
    "emotionFromTag 应以 undefined 表示未推断（#1567）");

  console.log("=== 情绪推断顺序一致（#1567：" + scriptOrder.join(" > ") + "）===");
}

main();
