/**
 * #1556：`isRateLimitError` 必须与项目自己的错误分类器口径一致。
 *
 * 它决定 MiniMax 语音合成**要不要退避重试**（voice.ts 的 speakWithRetry）。原实现
 * `/1002|rate\s*limit|RPM|限流/` 比 classifyError 的 rate_limit 窄得多，于是对方把限流写成
 * `429` / `Too many requests` / `请求过于频繁` 时，这一句会跳过退避重试直接走兜底音色——
 * 结果是**音色不一致**（用了兜底音色）或整句失败，而几秒退避原本就能救回来。
 *
 * 另一侧同样要守：**非限流**的错误必须返回 false，否则鉴权/参数错误会被反复重试，白烧 TTS 费用。
 */
import { isRateLimitError } from "../src/core/voice";
import { classifyError } from "../src/utils/errorClassifier";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 分类器认作 rate_limit 的典型措辞——一个都不许漏 */
const RATE_LIMIT: string[] = [
  "code 1002",
  "RPM limit",
  "429 Too Many Requests",
  "Too many requests: please slow down",
  "rate limit exceeded",
  "Rate limit reached for gpt-4 on tokens per min",
  "quota exceeded",
  "insufficient_quota",
  "billing_hard_limit_reached",
  "请求过于频繁，请稍后重试",
  "频率超限",
  "触发限流",
  "并发超限",
  "账户余额不足，请充值",
];

/** 绝不能被当成限流的错误（重试只会白烧 TTS 费用） */
const NOT_RATE_LIMIT: string[] = [
  "invalid api key",
  "401 Unauthorized",
  "invalid voice id",
  "音色不存在",
  "content policy violation",
  "已中止",
  "model_not_found",
];

function main(): void {
  // 正例：分类器认作 rate_limit 的，isRateLimitError 也必须认
  const missed = RATE_LIMIT.filter((m) => classifyError(new Error(m)) === "rate_limit" && !isRateLimitError(m));
  assert(missed.length === 0, "分类器认作限流但 isRateLimitError 漏判（会导致跳过退避重试）：" + missed.join("；") + "（#1556）");

  // 反例：非限流不得误判为限流
  const wrong = NOT_RATE_LIMIT.filter((m) => isRateLimitError(m));
  assert(wrong.length === 0, "非限流错误被误判为限流（会反复重试白烧费用）：" + wrong.join("；") + "（#1556）");

  // 2002 之外的纯数字 code 不得靠子串误命中（1002 是精确的 MiniMax code）
  assert(!isRateLimitError("error code 10025"), "10025 含子串 1002，但它是另一个 code，不应判限流（#1556）");

  console.log("=== isRateLimitError 与分类器口径一致（#1556：正例 " + RATE_LIMIT.length + " / 反例 " + NOT_RATE_LIMIT.length + "）===");
}

main();
