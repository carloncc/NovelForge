import { withRetry } from "../src/api/openaiCompatible";
import { classifyError } from "../src/utils/errorClassifier";
import { retryDelayFor } from "../src/api/http";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  // 1) 可重试错误（429）：失败 2 次后成功（默认 retries=2 → 共 3 次调用）
  let calls = 0;
  const ok = await withRetry(async () => {
    calls++;
    if (calls < 3) throw { status: 429, message: "HTTP 429" };
    return "done";
  });
  assert(ok === "done" && calls === 3, `应重试后成功，实际调用 ${calls} 次`);

  // 2) 不可重试错误（400）：立即失败不重试
  calls = 0;
  let threw = false;
  try {
    await withRetry(async () => {
      calls++;
      throw { status: 400, message: "bad request" };
    });
  } catch {
    threw = true;
  }
  assert(threw && calls === 1, `400 不应重试，实际调用 ${calls} 次`);

  // 3) 重试耗尽：仍抛最终错误（默认 retries=2 → 共 3 次调用）
  calls = 0;
  threw = false;
  try {
    await withRetry(async () => {
      calls++;
      throw { status: 429, message: "HTTP 429" };
    });
  } catch (e) {
    threw = true;
    assert((e as { status?: number }).status === 429, "应抛最终错误");
  }
  assert(threw && calls === 3, `重试耗尽应失败，实际调用 ${calls} 次`);

  // 4) 错误分类：网络/限流可重试，鉴权/参数不可重试，内容审查归为审查
  assert(classifyError(new Error("fetch failed: network error")) === "network", "网络错误应可重试");
  assert(classifyError(new Error("connection timed out")) === "network", "超时应可重试");
  assert(classifyError(new Error("invalid"), 400) === "invalid_param", "400 不可重试");
  assert(classifyError(new Error("content_rejected by reviewer")) === "content_moderation", "内容审查应被识别");
  assert(classifyError(new Error("insufficient balance")) === "rate_limit", "余额不足应限流");
  assert(classifyError(new Error("invalid api key")) === "auth", "鉴权失败应识别");

  // 5) 递增间隔：1s → 10s → 20s → … → 60s 封顶
  assert(retryDelayFor(0) === 1000, "首次重试 1s");
  assert(retryDelayFor(1) === 10000, "第二次 10s");
  assert(retryDelayFor(2) === 20000, "第三次 20s");
  assert(retryDelayFor(6) === 60000, "第 7 次封顶 60s");
  assert(retryDelayFor(99) === 60000, "之后保持 60s 封顶");

  console.log("=== 重试机制测试通过 ===");
}
main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
