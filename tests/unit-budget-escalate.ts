/**
 * 预算升级判定（第 2 章 300s 事件复盘）：
 * 仅「被截断且内容为空」（推理思考耗尽预算）时升级；
 * 截断但有内容的响应（含残缺 JSON）一律不升级——由续写循环分段取回，
 * 否则慢后端上更大的单次输出更注定超时。
 */
import { shouldEscalateBudget, nextBudgetAfterThinking, shouldContinueJson, reasoningTokensUsed, escalationFutile } from "../src/api/openaiCompatible";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/* ---------- 升级：空内容 + length ---------- */
assert(shouldEscalateBudget("length", ""), "空内容 + length 必须升级");
assert(shouldEscalateBudget("length", "   \n  "), "空白内容 + length 必须升级");

/* ---------- 不升级：截断但有内容 ---------- */
assert(!shouldEscalateBudget("length", '{"scenes":[{'), "残缺 JSON 不得升级（走续写）");
assert(!shouldEscalateBudget("length", "x".repeat(8000)), "8K 截断响应不得升级（走续写）");

/* ---------- 不升级：非截断 ---------- */
assert(!shouldEscalateBudget("stop", ""), "stop 即使空也不升级");
assert(!shouldEscalateBudget("stop", '{"a":1}'), "正常 stop 不升级");
assert(!shouldEscalateBudget(undefined, ""), "无 finishReason 不升级");

/* ---------- 下一次预算：按实际思考量补足，保证正文有预算（不针对特定模型） ---------- */
{
  const next = nextBudgetAfterThinking(8192, { reasoningTokens: 9000 }, 8192);
  assert(next >= 9000 + 8192, `应至少给到「思考量 + 正文预算」，实际 ${next}`);
}
{
  // 未报告 reasoning_tokens 时按 reasoning 文本长度估算
  const next = nextBudgetAfterThinking(8192, { reasoning: "思".repeat(10000) }, 4096);
  assert(next >= 5000 + 4096, `应按文本估算思考量，实际 ${next}`);
}
{
  // 无任何思考信息时至少比上次多 8000，避免原地打转
  const next = nextBudgetAfterThinking(8192, { reasoningTokens: 0, reasoning: "" }, 8192);
  assert(next === 8192 + 8000, `无思考信息时应至少 +8000，实际 ${next}`);
}

/* ---------- 思考量估算 ---------- */
assert(reasoningTokensUsed({ reasoningTokens: 9000 }) === 9000, "优先用服务端报告的 reasoning_tokens");
assert(reasoningTokensUsed({ reasoningTokens: 0, reasoning: "思".repeat(10000) }) === 5000, "缺失统计按文本估 token");
assert(reasoningTokensUsed({ reasoningTokens: 9000, reasoning: "思".repeat(10000) }) === 9000, "报告值更大时取报告值");
assert(reasoningTokensUsed({}) === 0, "无任何思考信息为 0");

/* ---------- 膨胀判定：放大后又被思考耗尽 → 停手（用户实测 8K→18K→28K→35K 全空） ---------- */
assert(escalationFutile(18567, { reasoningTokens: 18571 }), "放大到 18.5K 又全被思考吃掉必须判停");
assert(escalationFutile(8192, { reasoning: "思".repeat(16000) }), "按文本估算吃满预算也判停");
assert(!escalationFutile(18567, { reasoningTokens: 5000 }), "思考量明显小于预算属其它故障，不判停");
assert(!escalationFutile(18567, {}), "无思考信息不判停（无法归因）");
assert(!escalationFutile(0, { reasoningTokens: 100 }), "预算为 0 不判停");
{
  // 有界思考模型：放大后思考 9K（占 18.5K 的 49%）→ 不判停，正文得以产出
  const next = nextBudgetAfterThinking(8192, { reasoningTokens: 8192 }, 8192);
  assert(!escalationFutile(next, { reasoningTokens: 9000 }), "有界思考模型放大一次后不得被误停");
}

/* ---------- 续写判定：生成多少、下轮往后补（总量无天花板，有停滞保护） ---------- */
assert(shouldContinueJson("length", 0, 10, 8000, 500), "首轮截断必须续写");
assert(shouldContinueJson("length", 5, 10, 8000, 500), "中途截断继续续写");
assert(!shouldContinueJson("stop", 0, 10, 8000, 500), "stop 不续写");
assert(!shouldContinueJson("length", 10, 10, 8000, 500), "轮次用尽不续写");
assert(!shouldContinueJson("length", 2, 10, 100, 500), "第 2 次续写只新增 100 字判停滞");
assert(shouldContinueJson("length", 0, 10, 100, 500), "首轮即使短也续写（给一次机会）");
assert(shouldContinueJson("length", 2, 10, 100, 0), "不限进度时短续写也继续");

console.log("预算升级判定测试通过");
