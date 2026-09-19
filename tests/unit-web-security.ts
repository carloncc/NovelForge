import { join, normalize } from "node:path";
import { isPathInside, validateProxyUrl } from "../vite.config";
import { webHttp } from "../src/utils/webRuntime";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const base = normalize(join(process.cwd(), ".tmp-preview", "game"));
assert(isPathInside(base, join(base, "index.html")), "a child path must be accepted");
assert(!isPathInside(base, `${base}-sibling/index.html`), "a sibling sharing the same string prefix must be rejected");
assert(!isPathInside(base, join(base, "..", "outside.txt")), "parent traversal must be rejected");

assert(validateProxyUrl("https://api.example.com/v1").protocol === "https:", "HTTPS proxy targets must be accepted");
assert(validateProxyUrl("http://127.0.0.1:11434/v1").hostname === "127.0.0.1", "local HTTP targets must remain available for Ollama");
for (const target of ["file:///etc/passwd", "ftp://example.com/file", "not-a-url"]) {
  let rejected = false;
  try {
    validateProxyUrl(target);
  } catch {
    rejected = true;
  }
  assert(rejected, `unsafe proxy target must be rejected: ${target}`);
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
    let message = "";
    try {
      await webHttp({ method: "POST", url: "https://api.example.com/paid", body: "{}" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // 代理已把请求真实发往厂商（可能已计费），502 时静默直连会重复发送同一个付费 POST
    assert(/代理不可用 502/.test(message), `proxy 502 must surface as a proxy error, got: ${message}`);
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
