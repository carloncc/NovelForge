/**
 * #1563：images.ts 的内容审查阶梯同样**不得重发重复请求**。
 *
 * 与 #1562（visualBible 的同一逻辑）是同一个坑的两份实现。#1560 把 appendSafeStyleSuffix 改成幂等后，
 * 该阶梯第 2 阶在「未配置安全改写 LLM」或「LLM 返回空」时变成**空操作**，而代码紧跟着 continue——
 * 重发的是与上一阶**逐字节相同**的请求，必定同样被拒：一次纯烧钱的付费图像调用。
 *
 * 修法：进入每阶前记下 promptBeforeStage，本阶结束后比较；没推进就**不再 continue**，
 * 直接落到紧随其后的「改写用尽」分支抛出（复用既有且正确的失败路径）。
 *
 * 局限说明（如实记录）：该阶梯嵌在 runImageTask 这个很大的私有异步函数里，无法直接单测，
 * 因此这里校验**源码契约**。阶梯所依赖的纯函数（appendSafeStyleSuffix 的幂等性）由
 * tests/unit-safe-style-suffix.ts 行为测试覆盖。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const SRC = readFileSync(join(process.cwd(), "src", "core", "images.ts"), "utf8");

function main(): void {
  // ① 必须记录本阶改写前的提示词
  assert(SRC.includes("const promptBeforeStage = prompt;"),
    "进入审查阶梯各阶前必须记录 promptBeforeStage（否则无法判定有没有推进）（#1563）");

  // ② 必须存在「没推进就不重发」的判定
  assert(SRC.includes("if (prompt === promptBeforeStage) {"),
    "images.ts 必须存在「改写未推进则不再重发」的判定（#1563）");

  // ③ 真正的要害：continue 必须只出现在「有推进」那一支里。
  //    若把 continue 提到判定之外（回到旧写法），就会重发同一个请求。
  const guardAt = SRC.indexOf("if (prompt === promptBeforeStage) {");
  assert(guardAt >= 0, "找不到判定位置（#1563）");
  const window = SRC.slice(guardAt, guardAt + 900);
  const elseIdx = window.indexOf("} else {");
  const contIdx = window.indexOf("continue;");
  assert(elseIdx >= 0 && contIdx >= 0, "判定周围应同时有 else 分支与 continue（#1563）");
  assert(contIdx > elseIdx,
    "continue 必须落在「有推进」的 else 分支内；若在判定之外就会重发同一个请求（#1563）");

  // ④ 反向确认：本阶梯仍保留了「已改写提示词重试」的正常路径（不是被阉割成永不重试）
  assert(SRC.includes("已改写提示词重试（第 ${moderationStage} 阶）"),
    "不得把阶梯写成永不重试（正常的改写重试路径必须保留）（#1563）");

  console.log("=== images 审查阶梯「未推进不重发」契约通过（#1563）===");
}

main();
