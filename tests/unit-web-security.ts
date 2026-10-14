import { join, normalize } from "node:path";
import { isPathInside, parseRangeHeader, previewRequestAllowed, validateProxyUrl } from "../vite.config";
import { ProxyHttpError, webHttp } from "../src/utils/webRuntime";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const base = normalize(join(process.cwd(), ".tmp-preview", "game"));
assert(isPathInside(base, join(base, "index.html")), "a child path must be accepted");
assert(!isPathInside(base, `${base}-sibling/index.html`), "a sibling sharing the same string prefix must be rejected");
assert(!isPathInside(base, join(base, "..", "outside.txt")), "parent traversal must be rejected");

// #1549：预览静态服务此前没有任何 Host/Origin 校验（与 Rust 预览服务器口径不一致）。
// 这里只钉住闸门本身；真实的 403/206 端到端断言在 tests/unit-fix-security.ts 里直连端口验证。
{
  const PORT = 54321;
  const req = (headers: Record<string, string>) => ({ headers, method: "GET" }) as never;
  assert(previewRequestAllowed(req({ host: `127.0.0.1:${PORT}` }), PORT), "本机 Host 的顶层导航必须放行");
  assert(!previewRequestAllowed(req({ host: `evil.com:${PORT}` }), PORT), "非本机 Host（DNS rebinding）必须拒绝");
  assert(
    !previewRequestAllowed(req({ host: `127.0.0.1:${PORT}`, origin: "https://evil.com" }), PORT),
    "跨站 Origin 必须拒绝",
  );
  assert(
    previewRequestAllowed(req({ host: `127.0.0.1:${PORT}`, referer: "http://127.0.0.1:5173/" }), PORT),
    "应用页 Referer（Web 模式 window.open 预览）必须放行",
  );
  assert(parseRangeHeader("bytes=100-", 1000)?.join(",") === "100,999", "开区间 Range 必须解析到文件末尾");
  assert(parseRangeHeader("bytes=-50", 1000)?.join(",") === "950,999", "后缀 Range 必须取尾部 N 字节");
  assert(parseRangeHeader("bytes=5000-", 1000) === null, "越界 Range 必须退化成整文件 200");
}

assert(validateProxyUrl("https://api.example.com/v1").protocol === "https:", "HTTPS proxy targets must be accepted");
assert(validateProxyUrl("http://127.0.0.1:11434/v1").hostname === "127.0.0.1", "local HTTP targets must remain available for Ollama");
assert(validateProxyUrl("http://localhost:1234/v1").hostname === "localhost", "localhost must remain available for local models");
for (const target of ["file:///etc/passwd", "ftp://example.com/file", "not-a-url"]) {
  let rejected = false;
  try {
    validateProxyUrl(target);
  } catch {
    rejected = true;
  }
  assert(rejected, `unsafe proxy target must be rejected: ${target}`);
}
// #791 私网/链路本地/云元数据：同源脚本被注入时不能借代理探测内网
for (const target of [
  "http://169.254.169.254/latest/meta-data",
  "http://10.0.0.5/v1",
  "http://172.20.3.4/v1",
  "http://192.168.1.10:8080/v1",
  "http://0.0.0.0:8000/v1",
  "http://100.64.0.1/v1",
  "http://[fe80::1]/v1",
  "http://[fd00::1]/v1",
  "http://[::ffff:192.168.0.1]/v1",
]) {
  let rejected = false;
  try {
    validateProxyUrl(target);
  } catch {
    rejected = true;
  }
  assert(rejected, `private/metadata proxy target must be rejected: ${target}`);
}

const SESSION_PATH = "/__novelforge/session";

async function testDirectFallbackRejectsOversizedResponse(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith(SESSION_PATH)) return new Response(JSON.stringify({ token: "test-token" }), { status: 200 });
    networkCalls++;
    // B97：只有网络层异常（fetch reject）才允许直连回退；代理返回的 HTTP 状态一律不回退
    if (networkCalls === 1) throw new TypeError("fetch failed");
    return new Response(new Uint8Array(0), { status: 200, headers: { "content-length": String(64 * 1024 * 1024 + 1) } });
  };
  try {
    let oversizedRejected = false;
    try {
      await webHttp({ method: "GET", url: "https://api.example.com/oversized" });
    } catch (error) {
      oversizedRejected = error instanceof Error && /too large|过大/i.test(error.message);
    }
    assert(oversizedRejected, "direct web fallback must enforce the same response limit as the proxy");
    assert(networkCalls === 2, `proxy network failure should fall back to one direct fetch, network calls: ${networkCalls}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testProxyHttpErrorIsNotReplayedDirectly(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith(SESSION_PATH)) return new Response(JSON.stringify({ token: "test-token" }), { status: 200 });
    networkCalls++;
    return new Response("bad gateway", { status: 502 });
  };
  try {
    let error: unknown;
    try {
      await webHttp({ method: "POST", url: "https://api.example.com/paid", body: "{}" });
    } catch (e) {
      error = e;
    }
    // 代理已把请求真实发往厂商（可能已计费），502 时静默直连会重复发送同一个付费 POST
    // 断言类型与状态码而非文案：文案随界面语言变化（英文环境为 "Proxy unavailable 502..."）
    assert(error instanceof ProxyHttpError, `proxy 502 must surface as ProxyHttpError, got: ${String(error)}`);
    assert((error as ProxyHttpError).status === 502, `proxy 502 must keep its HTTP status, got: ${(error as ProxyHttpError).status}`);
    assert(networkCalls === 1, `proxy 5xx must not trigger a direct replay, network calls: ${networkCalls}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testProxy403RefreshesSessionTokenOnce(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let sessionCalls = 0;
  let proxyCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith(SESSION_PATH)) {
      sessionCalls++;
      return new Response(JSON.stringify({ token: `token-${sessionCalls}` }), { status: 200 });
    }
    proxyCalls++;
    if (proxyCalls === 1) return new Response("forbidden", { status: 403 });
    return new Response(JSON.stringify({ status: 200, contentType: "application/json", bodyBase64: "" }), { status: 200 });
  };
  try {
    const result = await webHttp({ method: "POST", url: "https://api.example.com/paid", body: "{}" });
    assert(result.status === 200, "403 后应带着新 token 重放并返回结果");
    assert(proxyCalls === 2, `403 只允许重放一次，实际代理调用 ${proxyCalls} 次`);
    assert(sessionCalls >= 1, "403 后必须重新获取会话 token 而不是复用旧 token");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await testDirectFallbackRejectsOversizedResponse();
await testProxyHttpErrorIsNotReplayedDirectly();
await testProxy403RefreshesSessionTokenOnce();

console.log("=== web security helper tests passed ===");
