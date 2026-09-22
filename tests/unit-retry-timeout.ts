/**
 * 超时重试配额（withRetry timeoutRetries）：
 * - 剧本大输出场景传 0：第一次 300s 超时即抛（上层拆小重试），不再烧 N×300s；
 * - 默认行为不变：普通网络错误走满 4 次重试；
 * - timeoutRetries 只约束超时类错误，非超时错误不受影响。
 */
import { withRetry } from "../src/api/openaiCompatible";

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

console.log("超时重试配额测试通过");
