/**
 * #1557：**同一判定在多处各写一份**是这套代码反复出问题的地方（#1548 抠图、#1556 限流）。
 * 本轮抓到两处：
 *
 * ① 中止判定。openaiCompatible 的流式失败分支自带一份窄正则 `/已中止|请求被取消|cancelled/i`，
 *    缺 `aborted` / `canceled`（单 l）/ `已取消`。而 web 运行时 fetch 中止抛的正是
 *    「The user aborted a request.」——漏判后不会原样抛出，会掉进「回退整包请求重发一次」，
 *    **对用户已经取消的请求继续计费**（该处上一行注释明令禁止的事）。
 * ② isServerClassFailure 只列了 500/502/503/504，漏整个 505-599，**尤其 Cloudflare 的 520-527**
 *    （中转站极常见），漏判会让瞬时故障被当成「非服务端故障」，调用方不再重试/降级。
 */
import { classifyError } from "../src/utils/errorClassifier";
import { isServerClassFailure } from "../src/core/script";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main(): void {
  // ① 中止判定：web fetch 与各家运行时的实际文案都必须判 aborted
  const ABORTS = [
    "The user aborted a request.",
    "AbortError: The operation was aborted.",
    "已中止",
    "请求被取消",
    "已取消",
    "cancelled",
    "canceled",
  ];
  const notAbort = ABORTS.filter((m) => classifyError(new Error(m)) !== "aborted");
  assert(notAbort.length === 0, "这些中止文案必须判 aborted（漏判会导致取消后仍重发＝继续计费）：" + notAbort.join("；") + "（#1557）");

  // 反向：非中止错误不得判成 aborted（否则真正的失败会被当成「用户取消」而静默吞掉）
  const NOT_ABORT = ["500 Internal Server Error", "model_not_found", "429 Too Many Requests", "invalid api key"];
  const wrongAbort = NOT_ABORT.filter((m) => classifyError(new Error(m)) === "aborted");
  assert(wrongAbort.length === 0, "非中止错误被误判为 aborted（会被静默吞掉）：" + wrongAbort.join("；") + "（#1557）");

  // ② 5xx 覆盖：Cloudflare 520-527 与其它 5xx 都必须算服务端故障
  const FIVE_XX = [500, 501, 505, 510, 520, 521, 522, 523, 524, 525, 526, 527, 530, 599];
  // 注意用**真实形态**：调用方是把 status 挂在 Error 上的（httpStatusError）。
  // 不能用裸对象 {status,message}——那种形态会让 failureText 拼出 "status=520 …"，
  // 于是纯文本兜底也能命中，status 分支是否放宽就分辨不出来了（负控会假存活）。
  const withStatus = (st: number) => Object.assign(new Error("boom"), { status: st });
  const missedStatus = FIVE_XX.filter((st) => !isServerClassFailure(withStatus(st)));
  assert(missedStatus.length === 0, "这些 5xx 必须判为服务端故障（漏判会让调用方不再重试/降级）：" + missedStatus.join(",") + "（#1557）");

  assert(isServerClassFailure(withStatus(429)), "429 必须判为服务端故障（#1557）");
  for (const s of [400, 401, 403, 404, 422]) {
    assert(!isServerClassFailure(withStatus(s)), "客户端错误不得判为服务端故障：" + s + "（#1557）");
  }

  // 文本路径同样要覆盖 520-527（调用方常常拿不到 status）
  const textMissed = ["HTTP 522", "status 524", "520"].filter((m) => !isServerClassFailure(new Error(m)));
  assert(textMissed.length === 0, "纯文本的 520-527 也必须判服务端故障：" + textMissed.join("；") + "（#1557）");

  console.log("=== 中止判定与 5xx 覆盖测试通过（#1557：中止 " + ABORTS.length + " 例 / 5xx " + FIVE_XX.length + " 例）===");
}

main();
