/**
 * 本轮修复的回归护栏（详见交付说明）：
 *  1. Web 代理：HTTP 200 但响应体被截断导致 JSON 解析失败时，不得回退直连重发
 *     （否则同一个付费 POST 被厂商计费两次，第一次的结果被丢弃）。
 *  2. classifyError：408 / 425 属「可重试」，不应落进 >= 400 的 invalid_param 兜底。
 *  3. vfsReplacePath：改为单事务后 happy path 仍正确，且源不存在时目标不被清空。
 */
import "fake-indexeddb/auto";
import { classifyError } from "../src/utils/errorClassifier";
import { ProxyHttpError, webHttp } from "../src/utils/webRuntime";
import { vfsReplacePath, vfsWriteTextFile, vfsReadTextFile } from "../src/utils/vfsWeb";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const SESSION_PATH = "/__novelforge/session";

/** 1. 代理已回 200、但响应体解析失败 —— 请求已送达，绝不能再直连重发 */
async function testParseFailureAfterProxyResponseIsNotReplayed(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith(SESSION_PATH)) return new Response(JSON.stringify({ token: "test-token" }), { status: 200 });
    networkCalls++;
    // 200 + 截断的 JSON：厂商已收到并计费，但代理回来的包在半路断了
    return new Response('{"status":200,"bodyBase64":"AAAA', { status: 200 });
  };
  try {
    let error: unknown;
    try {
      await webHttp({ method: "POST", url: "https://api.example.com/paid-image", body: "{}" });
    } catch (e) {
      error = e;
    }
    assert(error instanceof ProxyHttpError, `解析失败应按「已送达」处理并抛 ProxyHttpError，实际: ${String(error)}`);
    assert(
      networkCalls === 1,
      `代理已返回响应后不得直连重发（会把付费 POST 再发一次），network calls: ${networkCalls}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** 2. 408 / 425 可重试；400/422 仍是永久参数错 */
function testRetryableStatusClassification(): void {
  assert(classifyError(new Error("API 错误 408: Request Timeout"), 408) === "network", "408 应判 network（可退避重试）");
  assert(classifyError(new Error("API 错误 425: Too Early"), 425) === "network", "425 应判 network（可退避重试）");
  // 不回归：真·参数错仍然零重试
  assert(classifyError(new Error("bad request"), 400) === "invalid_param", "400 仍应判 invalid_param");
  assert(classifyError(new Error("HTTP 422 unprocessable"), 422) === "invalid_param", "422 仍应判 invalid_param");
  assert(classifyError(new Error("unauthorized"), 401) === "auth", "401 仍应判 auth");
  assert(classifyError(new Error("boom"), 503) === "network", "503 仍应判 network");
}

/** 3. vfsReplacePath 改为单事务后：正常替换生效，源缺失时目标原样保留 */
async function testReplacePathSemantics(): Promise<void> {
  await vfsWriteTextFile("/app/r7/tmp/new.txt", "NEW");
  await vfsWriteTextFile("/app/r7/state/old.txt", "OLD");
  await vfsWriteTextFile("/app/r7/state/keep.txt", "KEEP");

  await vfsReplacePath("/app/r7/tmp", "/app/r7/state");
  assert((await vfsReadTextFile("/app/r7/state/new.txt")) === "NEW", "替换后应存在 new.txt");
  // 目标路径原有内容应被整体清空（replace 语义 = 换掉，不是合并）
  assert((await vfsReadTextFile("/app/r7/state/old.txt")) === undefined, "替换后目标原有内容应被清空");

  // 源不存在时必须抛错，且不得动目标
  await vfsWriteTextFile("/app/r7/state/keep.txt", "KEEP");
  let failed = false;
  try {
    await vfsReplacePath("/app/r7/does-not-exist", "/app/r7/state");
  } catch {
    failed = true;
  }
  assert(failed, "源路径不存在应抛错");
  assert((await vfsReadTextFile("/app/r7/state/keep.txt")) === "KEEP", "替换失败后目标内容必须原样保留（原子性）");
}

async function main(): Promise<void> {
  await testParseFailureAfterProxyResponseIsNotReplayed();
  testRetryableStatusClassification();
  await testReplacePathSemantics();
  console.log("=== 计费/原子性回归测试通过 ===");
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
