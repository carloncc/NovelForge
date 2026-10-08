/**
 * #1555：错误分类的**另一个花钱方向**——临时故障被判成永久错误。
 *
 * 前两轮（#1553/#1554）查的是「永久错误被判成可重试 → 对注定失败的请求反复计费」。
 * 本轮反过来查：**临时故障被判成永久（invalid_param/auth/content_moderation）**，
 * 后果是**一次就放弃**，用户白等一场却拿不到「重试一次就能成功」的结果。
 *
 * 实测抓到一个真实且高发的：gRPC 的 `DEADLINE_EXCEEDED`（Google/Gemini 系列的标准超时错误）。
 * `context deadline exceeded` 会先命中 invalid_param 的
 * `(max|context|length|prompt).{0,30}(exceed|…)`——把**超时**读成了**上下文超长**，
 * 判成永久错误、零重试。本应用支持 Gemini 视觉/图像，这条路径是活的。
 */
import { classifyError } from "../src/utils/errorClassifier";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const RETRYABLE = new Set(["network", "rate_limit", "unknown"]);
const PERMANENT = new Set(["auth", "invalid_param", "content_moderation"]);

/** [报错文本, 期望分类] */
const CASES: Array<[string, string]> = [["Request timed out: invalid response from upstream","network"],
  ["upstream error: context deadline exceeded","network"],
  ["DEADLINE_EXCEEDED","network"],
  ["4 DEADLINE_EXCEEDED: Deadline exceeded","network"],
  ["rpc error: code = DeadlineExceeded desc = context deadline exceeded","network"],
  ["The server is overloaded, please retry","network"],
  ["503 model not found","network"],
  ["502 bad gateway: upstream connect error","network"],
  ["503 Service Temporarily Unavailable","network"],
  ["429 rate limit: quota exceeded for requests per minute","rate_limit"],
  ["Too many requests: please slow down","rate_limit"],
  ["Rate limit reached for gpt-4 in organization org-x on tokens per min","rate_limit"],
  ["Read timed out. (read timeout=300)","network"],
  ["Connection aborted.', RemoteDisconnected('Remote end closed connection without response')","network"],
  ["The read operation timed out","network"],
  ["The upstream server returned an invalid response","unknown"],
  ["no such host","network"],
  ["TLS handshake timeout","network"],
  ["The engine is currently overloaded, please try again later","network"],
  ["Empty response from upstream (server_error)","network"]];

function main(): void {
  const wrong: string[] = [];
  const gaveUp: string[] = [];
  for (const [msg, want] of CASES) {
    const got = classifyError(new Error(msg));
    if (got !== want) wrong.push(JSON.stringify(msg.slice(0, 44)) + " 期望 " + want + " 实际 " + got);
    // 方向断言：期望可重试的输入，绝不能被判成永久类别（那等于提前放弃）
    if (RETRYABLE.has(want) && PERMANENT.has(got)) gaveUp.push(msg.slice(0, 44));
  }
  assert(gaveUp.length === 0, "临时故障被判成永久错误（会提前放弃、白丢本可重试成功的结果）：" + gaveUp.join("；") + "（#1555）");
  assert(wrong.length === 0, wrong.join("；") + "（#1555）");

  console.log("=== 临时错误分类测试通过（#1555：" + CASES.length + " 例，无临时故障被判永久）===");
}

main();
