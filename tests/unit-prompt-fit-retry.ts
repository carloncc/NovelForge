/**
 * #1561：提示词超长的压缩重试，必须确认**真的压短了**再重发。
 *
 * fitImagePrompt 在 `prompt.length <= maxChars` 时**原样返回**（images.ts:1421）。而服务端报文里的
 * 「长度」口径未必是 JS 字符——可能是 token、也可能是 UTF-8 字节。中文提示词按字节算时，
 * 服务端给出的上限数字会**大于**我们的字符数，于是压缩函数返回原串，重试发出的是
 * **一模一样的请求**：一次注定同样失败的付费图像调用。
 *
 * 与预算升级阶梯的 `if (next <= budget) break`（openaiCompatible.ts:1087）是同一个道理。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fitImagePrompt, promptLimitFromError } from "../src/core/images";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main(): void {
  // ① 前提：上限不小于当前长度时，压缩函数原样返回——这正是「白重发」的入口
  const short = "a warrior, night, city wall";
  assert(fitImagePrompt(short, short.length) === short,
    "前置条件不成立：长度正好等于上限时应原样返回（#1561）");
  assert(fitImagePrompt(short, short.length + 500) === short,
    "前置条件不成立：上限大于长度时应原样返回（这正是 token/字节口径错配的情形）（#1561）");

  // ② 因此「压短了才算有效重试」是必要的判据：上面两种情况都不该触发重发
  const unchanged = fitImagePrompt(short, short.length + 500);
  assert(!(unchanged.length < short.length),
    "该输入下不应判定为「已压短」（若判定为压短就会白重发一次付费请求）（#1561）");

  // ③ 真正超长时必须能压短（别把守卫写成「永不重试」）
  const long = "subject, " + "very detailed description phrase, ".repeat(160);
  const fitted = fitImagePrompt(long, 400);
  assert(fitted.length < long.length, "超长提示词必须能被压短（#1561）");
  assert(fitted.length <= 400, "压短后必须不超过上限，实际 " + fitted.length + "（#1561）");

  // ④ 上限解析：只有报文里给出可用的数字才算（过小的数字视为噪声）
  assert(promptLimitFromError("prompt length must be less than 1500") === 1500, "英文报文的 1500 应被解析（#1561）");
  assert(promptLimitFromError("提示词不能大于 1200 个字符") === 1200, "中文报文的 1200 应被解析（#1561）");
  assert(promptLimitFromError("提示词不能大于 5 个字符") === 0, "过小数字应视为噪声返回 0（#1561）");
  assert(promptLimitFromError("something else entirely") === 0, "无数字应返回 0（#1561）");

  // ⑤ 源码契约：该守卫在 images.ts 的重试循环里（不是纯函数，无法直接单测），
  //    因此校验源码形态——必须存在「压短了才重发」的判据，且不得残留无判据的重发。
  const SRC = readFileSync(join(process.cwd(), "src", "core", "images.ts"), "utf8");
  assert(SRC.includes("if (fitted.length < prompt.length) {"),
    "images.ts 必须存在「确实压短才重试」的守卫（#1561）");
  // 覆盖缺口补丁：只断言「守卫存在」还不够——把压缩调用本身删掉（fitted = prompt）
  // 会让守卫永远不成立、功能被静默阉割，而守卫那一行依然在。所以这里再钉两件事：
  // 压缩调用必须真的在、结果必须写回 prompt。
  assert(SRC.includes("const fitted = fitImagePrompt(prompt, limit);"),
    "仍须真的调用 fitImagePrompt 做压缩（否则超长提示词不再有任何恢复路径）（#1561）");
  assert(SRC.includes("prompt = fitted;"),
    "压缩结果必须写回 prompt（否则压了也没用）（#1561）");
  assert(!/prompt = fitImagePrompt\(prompt, limit\);\s*\n\s*promptFitted = true;\s*\n\s*log\(/.test(SRC),
    "images.ts 不得残留「无条件压缩后直接重发」的旧写法（#1561）");

  console.log("=== 提示词压缩重试守卫测试通过（#1561：没压短就不重发，避免白烧一次付费调用）===");
}

main();
