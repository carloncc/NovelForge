/**
 * #1554：错误分类词表的**中文与 snake_case 覆盖**。
 *
 * 上一轮（#1553）开始改用「构造真实报错串跑一遍」的方式找分类器的错，本轮把语料扩到 42 条，
 * 重点是中文中转站措辞（本应用的真实用户群）与厂商 snake_case 错误码。
 *
 * 首跑 42 例里不符 17 例，其中 **10 例属于会花钱的方向**：永久错误（鉴权/参数/内容审查）
 * 被判成 unknown，而 unknown 在重试逻辑里按临时错误退避重试 4 次（1+10+20+30s）——
 * 鉴权失败重试多少次都不会成功，等于对注定失败的请求反复计费。
 *
 * 内容审查那几条还多一层损失：分类错了就**不会触发提示词改写补救**，等于丢掉唯一的过审手段。
 */
import { classifyError } from "../src/utils/errorClassifier";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 可重试的类别（unknown 按注释也会退避重试，所以它也在内） */
const RETRYABLE = new Set(["network", "rate_limit", "unknown"]);
/** 重试没有意义的永久类别 */
const PERMANENT = new Set(["auth", "invalid_param", "content_moderation"]);

/** [报错文本, 期望分类] */
const CASES: Array<[string, string]> = [["API 错误：当前分组上游负载已饱和，请稍后再试","network"],
  ["API 错误：无可用渠道","network"],
  ["API 错误：模型不存在，请检查模型名","invalid_param"],
  ["API 错误：令牌已过期，请重新获取","auth"],
  ["API 错误：该令牌无权访问该模型","auth"],
  ["API 错误：余额不足，请充值后重试","rate_limit"],
  ["API 错误：请求过于频繁，请降低并发","rate_limit"],
  ["API 错误：内容不合规，已被拒绝","content_moderation"],
  ["API 错误：该模型不支持此功能","invalid_param"],
  ["API 错误：上下文长度超出限制","invalid_param"],
  ["API 错误：参数错误：size 非法","invalid_param"],
  ["API 错误：图片尺寸不支持","invalid_param"],
  ["API 错误：服务器内部错误，请稍后重试","network"],
  ["API 错误：上游服务暂时不可用","network"],
  ["API 错误：连接超时","network"],
  ["API 错误：网关超时","network"],
  ["model_not_found","invalid_param"],
  ["invalid_request_error","invalid_param"],
  ["rate_limit_exceeded","rate_limit"],
  ["insufficient_quota","rate_limit"],
  ["context_length_exceeded","invalid_param"],
  ["server_error","network"],
  ["overloaded_error","network"],
  ["api_key_invalid","auth"],
  ["billing_hard_limit_reached","rate_limit"],
  ["content_policy_violation","content_moderation"],
  ["authentication_error","auth"],
  ["permission_denied","auth"],
  ["not_found_error","invalid_param"],
  ["502 Bad Gateway","network"],
  ["503 Service Unavailable","network"],
  ["524 A timeout occurred","network"],
  ["500 Internal Server Error","network"],
  ["The model `gpt-5` does not exist","invalid_param"],
  ["You exceeded your current quota","rate_limit"],
  ["This model's maximum context length is 8192 tokens","invalid_param"],
  ["Request timed out after 300s","network"],
  ["read ECONNRESET","network"],
  ["socket hang up","network"],
  ["Premature close","unknown"],
  ["模型名无效","invalid_param"],
  ["图像生成失败：不符合安全策略","content_moderation"]];

function main(): void {
  const wrong: string[] = [];
  const costly: string[] = [];
  for (const [msg, want] of CASES) {
    const got = classifyError(new Error(msg));
    if (got === want) continue;
    wrong.push(JSON.stringify(msg.slice(0, 40)) + " 期望 " + want + " 实际 " + got);
    if (PERMANENT.has(want) && RETRYABLE.has(got)) costly.push(msg.slice(0, 40));
  }
  assert(costly.length === 0, "永久错误被判成可重试（会白花钱重试 4 次）：" + costly.join("；") + "（#1554）");
  assert(wrong.length === 0, wrong.join("；") + "（#1554）");

  console.log("=== 错误分类词表测试通过（#1554：" + CASES.length + " 例，无永久错误落可重试类）===");
}

main();
