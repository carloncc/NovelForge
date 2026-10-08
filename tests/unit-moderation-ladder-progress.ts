/**
 * #1562：内容审查改写阶梯**不得发出重复请求**。
 *
 * 每次重试都是一次付费图像调用；若某一阶的改写没有推进（新提示词与当前相同），
 * 那次请求注定与上一次同因被拒——纯烧钱。
 *
 * 本缺陷是 #1560（把 appendSafeStyleSuffix 改成幂等）**带出来的**：
 * 幂等之后，「后缀分支」（sanitizePrompt 未改动提示词——干净提示词的常见情形）
 * 在第 1 阶追加过后缀，第 2 阶再追加就是空操作。修前实测：
 * 发出 3 次请求、只有 2 份不同提示词，第 3 次与第 2 次逐字节相同。
 *
 * 这里直接测被导出的纯函数 nextModerationPrompt：返回 null = 没有推进 = 不许重发。
 */
import { nextModerationPrompt } from "../src/core/visualBible";
import { appendSafeStyleSuffix, sanitizePrompt } from "../src/utils/promptRewriter";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 干净提示词：sanitizePrompt 不会改动它 → 走「后缀分支」 */
const CLEAN = "a landscape with mountains and a river at dawn";

function main(): void {
  // 前置条件：该输入确实走「后缀分支」
  const { prompt: safe, replaced } = sanitizePrompt(CLEAN);
  assert(replaced === 0 || safe === CLEAN, "前置条件不成立：本用例应走「后缀分支」（#1562）");

  // ① 第 0 阶：必须推进（加后缀），返回新串
  const s0 = nextModerationPrompt(0, CLEAN, CLEAN);
  assert(s0 !== null && s0 !== CLEAN, "第 0 阶应推进（追加安全后缀）（#1562）");

  // ② 第 1 阶：后缀已在 → 必须返回 null（没有推进，不许再发一次）
  const s1 = nextModerationPrompt(1, CLEAN, s0!);
  assert(s1 === null, "第 1 阶未推进时必须返回 null（否则会重发同一个请求，白烧一次付费调用），实际 " + JSON.stringify(s1) + "（#1562）");

  // 反面对照：证明②不是空跑——同一阶若当前提示词还没带后缀，就必须推进
  const s1b = nextModerationPrompt(1, CLEAN, CLEAN);
  assert(s1b !== null, "当前提示词未带后缀时，第 1 阶应推进（否则会把守卫写成「永不重试」）（#1562）");
  assert(s1b === appendSafeStyleSuffix(CLEAN), "第 1 阶推进时的结果应是追加后缀后的串（#1562）");

  // ③ 整条阶梯走一遍：任何两次发出的提示词都不得相同
  const sent: string[] = [];
  let current = CLEAN;
  for (let stage = 0; stage < 6; stage++) {
    sent.push(current);
    const next = nextModerationPrompt(stage, CLEAN, current);
    if (next === null) break;
    assert(next !== current, "推进时新提示词不得与当前相同（#1562）");
    current = next;
  }
  assert(new Set(sent).size === sent.length,
    "阶梯发出的提示词必须两两不同，实际 " + sent.length + " 次仅 " + new Set(sent).size + " 份不同（#1562）");

  // ④ 走「规则改写分支」时同样不得重复（另一条路径也要守）
  const DIRTY = "a warrior swings a sword in battle";
  const d0 = nextModerationPrompt(0, DIRTY, DIRTY);
  assert(d0 !== null, "规则改写分支的第 0 阶也应推进（#1562）");
  const d1 = nextModerationPrompt(1, DIRTY, d0!);
  const d2 = nextModerationPrompt(2, DIRTY, d1 ?? d0!);
  assert(d1 !== d0 || d1 === null, "规则改写分支第 1 阶要么推进、要么明确返回 null，不得给出相同的串（#1562）");
  assert(d2 !== d1 || d2 === null, "同上（第 2 阶）（#1562）");

  console.log("=== 内容审查阶梯「不重复请求」测试通过（#1562：3 次请求不再有 1 次逐字节重复）===");
}

main();
