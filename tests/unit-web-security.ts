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

async function testDirectFallbackRejectsOversizedResponse(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    if (fetchCount === 1) return new Response(JSON.stringify({ token: "test-token" }), { status: 200 });
    if (fetchCount === 2) return new Response("proxy unavailable", { status: 500 });
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
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await testDirectFallbackRejectsOversizedResponse();

console.log("=== web security helper tests passed ===");
