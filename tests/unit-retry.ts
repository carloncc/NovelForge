import { withRetry, isRetryable } from "../src/api/openaiCompatible";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  // 1) 可重试错误（429）：失败 2 次后成功
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

  // 3) 重试耗尽：仍抛最终错误
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

  // 4) 网络错误消息可重试
  assert(isRetryable(0, "fetch failed: network error"), "网络错误应可重试");
  assert(isRetryable(0, "connection timed out"), "超时应可重试");
  assert(!isRetryable(400, "invalid"), "400 不可重试");
  assert(!isRetryable(0, "无法解析 JSON 输出"), "解析错误不可重试");

  console.log("=== 重试机制测试通过 ===");
}
main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
