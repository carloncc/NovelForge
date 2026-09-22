/**
 * 预算升级判定（第 2 章 300s 事件复盘）：
 * 仅「被截断且内容为空」（推理思考耗尽预算）时升级；
 * 截断但有内容的响应（含残缺 JSON）一律不升级——由续写循环分段取回，
 * 否则慢后端上更大的单次输出更注定超时。
 */
import { shouldEscalateBudget } from "../src/api/openaiCompatible";

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

console.log("预算升级判定测试通过");
