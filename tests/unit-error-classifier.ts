/**
 * #1553：错误分类器的判定必须与「重试要花多少钱」一致。
 *
 * 分类直接决定重试策略，而重试 = 再次付费调用。两个方向都会亏：
 *   - 永久错误被判成可重试（unknown/network）→ 对着注定失败的请求退避重试 4 次（1+10+20+30s），反复计费；
 *   - 临时故障被判成永久（invalid_param）→ 一次就放弃，用户白等。
 * openaiCompatible.ts:916 的注释正是为前者写的：「unknown 并按网络错误退避重试 4 次…对注定失败的请求反复计费」。
 *
 * 本轮实测出的两个根因：
 *   ① 厂商常回 snake_case 错误码（model_not_found / server_error），而词表里写的是带空格的
 *      "not found" / "server error"，于是 model_not_found 落 unknown → 被当临时错误重试 4 次。
 *   ② 纯文本路径（调用方不传 status）按 PATTERNS 的声明顺序匹配，invalid_param 排在 network 之前，
 *      于是「500 Internal Server Error: model not found」被判成永久参数错误、零重试。
 */
import { classifyError } from "../src/utils/errorClassifier";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** [错误消息, status?, 期望分类] */
const CASES: Array<[string, number | undefined, string]> = [
  // ① snake_case 错误码：必须判永久错误，不得落 unknown
  ["model_not_found", undefined, "invalid_param"],
  ["API 错误：Internal error (type=server_error)", undefined, "network"],
  // ② 5xx 报文里带永久错误关键词时，5xx 优先（否则零重试）
  ["500 Internal Server Error: model not found", undefined, "network"],
  ["500 Internal Server Error", undefined, "network"],
  ["504 Gateway Timeout", undefined, "network"],
  ["Request failed with status code 502", undefined, "network"],
  // ③ 额度用尽的另一种中文说法
  ["该令牌额度已用尽", undefined, "rate_limit"],
  ["账户余额不足，请充值", undefined, "rate_limit"],
  // ④ 回归：这些是本文件历史上专门修过的口径，一条都不许被我改坏
  ["prompt exceeds maximum length 4000", undefined, "invalid_param"], // 旧 /exceed/ 曾把它当限流无限重试
  ["Error 400: invalid model 'gpt-4'", undefined, "invalid_param"],
  ["context_length_exceeded", undefined, "invalid_param"],
  ["已中止", undefined, "aborted"],
  ["未产出任何场景", undefined, "invalid_param"],
  ["429 Too Many Requests", undefined, "rate_limit"],
  ["insufficient balance", undefined, "rate_limit"],
  ["invalid api key", undefined, "auth"],
  ["模型不存在", undefined, "invalid_param"],
  ["请求过于频繁，请稍后重试", undefined, "rate_limit"],
  ["upstream connect error or disconnect/reset before headers. reset reason: connection timeout", undefined, "network"],
  // ⑤ 带 status 的分支不受本轮改动影响
  ["boom", 429, "rate_limit"],
  ["boom", 401, "auth"],
  ["boom", 503, "network"],
  ["boom", 408, "network"],
  ["boom", 425, "network"],
  ["boom", 400, "invalid_param"],
  // 6) 400 报文里带限流信号仍优先判限流（B94）
  ["rate limit exceeded", 400, "rate_limit"],
];

function main(): void {
  const wrong: string[] = [];
  for (const [msg, st, want] of CASES) {
    const got = classifyError(new Error(msg), st);
    if (got !== want) wrong.push(JSON.stringify(msg.slice(0, 40)) + " 期望 " + want + " 实际 " + got);
  }
  assert(wrong.length === 0, wrong.join("；") + "（#1553）");

  // 反向确认：永久错误绝不能被判成可重试类（这是花钱的那一侧）
  const RETRYABLE = new Set(["network", "rate_limit", "unknown"]);
  for (const [msg, st, want] of CASES) {
    if (want !== "invalid_param" && want !== "auth") continue;
    const got = classifyError(new Error(msg), st);
    assert(!RETRYABLE.has(got), "永久错误不得被判成可重试：" + JSON.stringify(msg.slice(0, 40)) + " → " + got + "（#1553）");
  }

  console.log("=== 错误分类器测试通过（#1553：" + CASES.length + " 例，含历史口径回归 + 永久错误不得可重试）===");
}

main();
