/**
 * 超时重试配额（withRetry timeoutRetries）：
 * - 剧本大输出场景传 0：第一次 300s 超时即抛（上层拆小重试），不再烧 N×300s；
 * - 默认行为不变：普通网络错误走满 4 次重试；
 * - timeoutRetries 只约束超时类错误，非超时错误不受影响。
 */
import { withRetry, requestTimeoutSecs } from "../src/api/openaiCompatible";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function expectThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("应当抛出但未抛出");
}

/* ---------- 1) 超时配额 0：一次即抛 ---------- */
let calls = 0;
const t0 = Date.now();
await expectThrow(() =>
  withRetry(
    async () => {
      calls++;
      throw new Error("请求失败: error sending request for url (https://x/v1/chat/completions)");
    },
    { timeoutRetries: 0, delayFor: () => 0 },
  ),
);
assert(calls === 1, `timeoutRetries:0 应只调用 1 次，实际 ${calls}`);
assert(Date.now() - t0 < 5000, "timeoutRetries:0 不应有退避等待");

/* ---------- 2) 默认行为不变 ---------- */
calls = 0;
await expectThrow(() =>
  withRetry(
    async () => {
      calls++;
      throw new Error("socket hang up");
    },
    { delayFor: () => 0 },
  ),
);
assert(calls === 5, `默认应 1+4=5 次调用，实际 ${calls}`);

/* ---------- 3) 非超时错误不受配额影响 ---------- */
calls = 0;
await expectThrow(() =>
  withRetry(
    async () => {
      calls++;
      throw new Error("socket hang up");
    },
    { timeoutRetries: 0, delayFor: () => 0 },
  ),
);
assert(calls === 5, `非超时错误应走满默认重试，实际 ${calls}`);

/* ---------- 4) 超时按预算放宽：32K 输出不得死守 300s ---------- */
{
  // 32K 输出在 100 tok/s 模型上要约 330s：必须给足，不能掐在 300s
  const t = requestTimeoutSecs(300, 32768, 32768);
  assert(t >= 330, `32K 预算的超时必须覆盖 330s，实际 ${t}`);
  assert(t <= 1800, `超时不得突破 30 分钟上限，实际 ${t}`);
  // 小预算仍按调用方的基准值，不被放大到离谱
  assert(requestTimeoutSecs(300, 8192, 8192) === 300, "8K 预算维持基准 300s");
  // 预算放大时按比例放宽
  assert(requestTimeoutSecs(300, 65536, 32768) >= 600, "预算翻倍时超时应放宽");
  // 真·卡死仍有界
  assert(requestTimeoutSecs(300, 200_000, 32768) === 1800, "超大预算封顶 30 分钟");
}

console.log("超时重试配额测试通过");
