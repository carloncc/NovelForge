/**
 * #1549 安全修复的定向单测（Web 侧 + 配置面）：
 *
 * 1) ③ Web 模式预览静态服务的请求闸门（Host/Origin/Referer/Sec-Fetch-Site）——
 *    直连真实监听端口验证，而不是只测纯函数：`Host: evil.com`（DNS rebinding）与
 *    跨站 Origin 必须 403，正常顶层导航与预览页同源子资源必须 200。
 * 2) ③ Range 支持：大文件按区间流式返回 206 + Content-Range（旧实现 readFile 整文件入内存、
 *    无 Accept-Ranges，视频拖动会整包重下）。
 * 3) ④ CSP：index.html 必须有 meta CSP（且带 object-src/base-uri 收紧、保留 Vite HMR 的 ws:），
 *    tauri.conf.json 的桌面 CSP 必须补上 object-src/base-uri/frame-ancestors。
 *
 * 为什么这些断言值得存在：这四项都属于「配置面/服务面」的缺失，任何一次重构都可能
 * 静默回退（CSP 被删、闸门被挪走、readFile 又回来），而它们在功能测试里全都看不出来。
 */
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { IncomingMessage } from "node:http";
import { closePreviewServer, ensurePreviewServer, parseRangeHeader, previewRequestAllowed } from "../vite.config";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 纯函数层：把闸门判定从 HTTP 层里独立出来，避免"只靠端到端"漏掉边界 */
function fakeRequest(headers: Record<string, string>): IncomingMessage {
  return { headers, method: "GET" } as unknown as IncomingMessage;
}

function testPreviewRequestGate(): void {
  const PORT = 54321;
  // 正常顶层导航：浏览器直接打开预览 URL，没有 Origin/Referer（Host 是本机预览端口）
  assert(
    previewRequestAllowed(fakeRequest({ host: `127.0.0.1:${PORT}` }), PORT),
    "本机 Host 的顶层导航必须放行",
  );
  // DNS rebinding：攻击者域名解析到 127.0.0.1 时 Host 是攻击者域名
  assert(!previewRequestAllowed(fakeRequest({ host: `evil.com:${PORT}` }), PORT), "非本机 Host 必须拒绝");
  assert(!previewRequestAllowed(fakeRequest({ host: `127.0.0.1.evil.com:${PORT}` }), PORT), "后缀伪装必须拒绝");
  // Host 端口必须与本实例一致（否则 dev server 端口可被当预览端口借用）
  assert(!previewRequestAllowed(fakeRequest({ host: "127.0.0.1:5173" }), PORT), "端口不一致必须拒绝");
  // 跨站页面 fetch 会带自己的 Origin
  assert(
    !previewRequestAllowed(fakeRequest({ host: `127.0.0.1:${PORT}`, origin: "https://evil.com" }), PORT),
    "跨站 Origin 必须拒绝",
  );
  assert(
    !previewRequestAllowed(fakeRequest({ host: `127.0.0.1:${PORT}`, origin: "http://127.0.0.1:5173" }), PORT),
    "本机但跨端口的 Origin（应用页 fetch 预览服务）必须拒绝",
  );
  assert(
    previewRequestAllowed(fakeRequest({ host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` }), PORT),
    "同源 Origin 必须放行",
  );
  // Web 模式的预览页由应用页 window.open 打开：顶层导航会带应用页 Referer（端口不同）
  assert(
    previewRequestAllowed(fakeRequest({ host: `127.0.0.1:${PORT}`, referer: "http://127.0.0.1:5173/index.html" }), PORT),
    "应用页 Referer（端口不同）必须放行，否则 Web 模式预览打不开",
  );
  assert(
    !previewRequestAllowed(fakeRequest({ host: `127.0.0.1:${PORT}`, referer: "https://evil.com/x" }), PORT),
    "跨站 Referer 必须拒绝",
  );
  // 攻击者加 Referrer-Policy: no-referrer 时 Referer 缺失，靠浏览器自发的 Sec-Fetch-Site 兜住
  assert(
    !previewRequestAllowed(fakeRequest({ host: `127.0.0.1:${PORT}`, "sec-fetch-site": "cross-site" }), PORT),
    "Sec-Fetch-Site: cross-site 必须拒绝（Referer 缺失时的兜底）",
  );
  assert(
    previewRequestAllowed(fakeRequest({ host: `127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin" }), PORT),
    "预览页自身子资源（same-origin）必须放行",
  );
  // 无 Host（HTTP/1.0 / 本机非浏览器客户端直连）：与 Rust 侧同口径放行
  assert(previewRequestAllowed(fakeRequest({}), PORT), "缺失 Host 时与 Rust 侧一致放行");
}

function testRangeParsing(): void {
  assert(JSON.stringify(parseRangeHeader("bytes=0-99", 1000)) === "[0,99]", "区间起始必须解析");
  assert(JSON.stringify(parseRangeHeader("bytes=100-", 1000)) === "[100,999]", "开区间必须取到文件末尾");
  assert(JSON.stringify(parseRangeHeader("bytes=-50", 1000)) === "[950,999]", "后缀区间必须取尾部 N 字节");
  // 越界/畸形一律退化成整文件 200（与 Rust parse_range 同口径），而不是 416/异常
  for (const [value, size] of [
    ["bytes=1000-", 1000],
    ["bytes=abc-def", 1000],
    ["items=0-10", 1000],
    ["bytes=0-99", 0],
    [undefined, 1000],
  ] as Array<[string | undefined, number]>) {
    assert(parseRangeHeader(value, size) === null, `非法 Range 必须返回 null: ${String(value)}/${size}`);
  }
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** 用 node:http 直连（fetch 无法伪造 Host 头，而 DNS rebinding 正是靠 Host 头区分的） */
function rawGet(port: number, path: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function testPreviewServerEndToEnd(): Promise<void> {
  const dir = join(tmpdir(), "novelforge-preview", "unit-fix-security");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.html"), "<html><body>preview ok</body></html>");
  const payload = Buffer.alloc(4096, 7);
  await writeFile(join(dir, "big.bin"), payload);
  const port = await ensurePreviewServer();
  try {
    const ok = await rawGet(port, "/unit-fix-security/index.html", { Host: `127.0.0.1:${port}` });
    assert(ok.status === 200, `正常导航应 200，实际 ${ok.status}`);
    assert(ok.body.toString().includes("preview ok"), "正常导航应返回文件内容");
    assert(ok.headers["accept-ranges"] === "bytes", "必须声明 Accept-Ranges: bytes");

    const rebind = await rawGet(port, "/unit-fix-security/index.html", { Host: "evil.com" });
    assert(rebind.status === 403, `Host: evil.com 必须 403（DNS rebinding），实际 ${rebind.status}`);

    const crossSite = await rawGet(port, "/unit-fix-security/index.html", {
      Host: `127.0.0.1:${port}`,
      Origin: "https://evil.com",
    });
    assert(crossSite.status === 403, `跨站 Origin 必须 403，实际 ${crossSite.status}`);

    const crossSiteFetch = await rawGet(port, "/unit-fix-security/index.html", {
      Host: `127.0.0.1:${port}`,
      "Sec-Fetch-Site": "cross-site",
    });
    assert(crossSiteFetch.status === 403, `Sec-Fetch-Site: cross-site 必须 403，实际 ${crossSiteFetch.status}`);

    const partial = await rawGet(port, "/unit-fix-security/big.bin", {
      Host: `127.0.0.1:${port}`,
      Range: "bytes=100-199",
    });
    assert(partial.status === 206, `Range 请求必须 206，实际 ${partial.status}`);
    assert(
      partial.headers["content-range"] === `bytes 100-199/${payload.length}`,
      `Content-Range 不正确: ${String(partial.headers["content-range"])}`,
    );
    assert(partial.body.length === 100, `分片长度必须为 100，实际 ${partial.body.length}`);
    assert(partial.body.equals(payload.subarray(100, 200)), "分片内容必须与源文件区间一致");

    const suffix = await rawGet(port, "/unit-fix-security/big.bin", {
      Host: `127.0.0.1:${port}`,
      Range: "bytes=-16",
    });
    assert(suffix.status === 206 && suffix.body.length === 16, "后缀 Range 必须返回末尾 16 字节");

    // 目录穿越：URL 解析本身会把 "." / ".." / "%2e%2e" 这些点段归一化掉（WHATWG 规范），
    // 所以字面与编码的点段穿越在解析层就已经失效 —— 这里钉住这一事实，避免有人误以为
    // isPathInside 是唯一防线。
    const literal = await rawGet(port, "/../unit-fix-security/index.html", { Host: `127.0.0.1:${port}` });
    assert(literal.status === 200, `字面 .. 由 URL 归一化处理，应正常返回，实际 ${literal.status}`);
    const encodedDots = await rawGet(port, "/%2e%2e/unit-fix-security/index.html", { Host: `127.0.0.1:${port}` });
    assert(encodedDots.status === 200, `%2e%2e 同样被 URL 归一化，应正常返回，实际 ${encodedDots.status}`);
    // 而编码的反斜杠 URL 解析不当分隔符、Windows 的 path 模块却当分隔符 —— 必须由 isPathInside 拦下
    const backslash = await rawGet(port, "/%2e%2e%5Cunit-fix-security%5Cindex.html", { Host: `127.0.0.1:${port}` });
    assert(backslash.status !== 200, `反斜杠穿越不得被服务，实际 ${backslash.status}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
    // 释放监听端口：否则 tsx 进程不退出
    closePreviewServer();
  }
}

async function testContentSecurityPolicy(): Promise<void> {
  const html = await readFile(join(ROOT, "index.html"), "utf8");
  const meta = /<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i.exec(html);
  assert(meta, "index.html 必须带 meta CSP（Web 模式此前完全没有 CSP 兜底）");
  const csp = meta[0];
  assert(/object-src 'none'/.test(csp), "meta CSP 必须禁插件内容 object-src 'none'");
  assert(/base-uri 'self'/.test(csp), "meta CSP 必须禁 <base> 劫持 base-uri 'self'");
  assert(/script-src 'self'/.test(csp), "meta CSP 必须限制脚本来源");
  assert(!/unsafe-eval/.test(csp), "meta CSP 不得放开 unsafe-eval（本项目无 new Function/eval）");
  assert(/connect-src[^;]*'self'/.test(csp), "connect-src 必须含 'self'（/proxy、/preview、/template、/model 同源）");
  assert(/connect-src[^;]*ws:\/\/localhost:\*/.test(csp), "connect-src 必须保留 Vite dev 的 ws://localhost:*（否则 HMR 死）");
  assert(/frame-src[^;]*http:\/\/127\.0\.0\.1:\*/.test(csp), "frame-src 必须覆盖 Web 模式预览的随机端口（预览页在 iframe 里）");
  // frame-ancestors 写在 meta 里会被浏览器忽略（规范如此），只能由响应头生效
  assert(!/frame-ancestors/.test(csp), "frame-ancestors 不应出现在 meta CSP 中（浏览器会忽略并告警）");

  const conf = JSON.parse(await readFile(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")) as {
    app: { security: { csp: string } };
  };
  const desktop = conf.app.security.csp;
  for (const directive of ["object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'"]) {
    assert(desktop.includes(directive), `桌面 CSP 缺少收紧项: ${directive}`);
  }
  assert(desktop.includes("connect-src 'self' ipc: http://ipc.localhost"), "桌面 CSP 不得丢失 Tauri IPC 通道");
}

/** 源码钉：预览静态服务必须仍走闸门 + 流式（防止 readFile 整文件读入被"顺手改回来"） */
async function testPreviewHandlerStaysStreaming(): Promise<void> {
  const src = await readFile(join(ROOT, "vite.config.ts"), "utf8");
  const start = src.indexOf("async function handlePreviewStatic");
  const end = src.indexOf("export function ensurePreviewServer");
  assert(start > 0 && end > start, "vite.config.ts 结构变化：找不到 handlePreviewStatic");
  const body = src.slice(start, end);
  assert(body.includes("previewRequestAllowed(req, previewPort)"), "预览静态服务必须先过 Host/Origin 闸门");
  assert(body.includes("parseRangeHeader"), "预览静态服务必须解析 Range");
  assert(body.includes("streamPreviewFile"), "预览静态服务必须流式返回");
  assert(!body.includes("readFile("), "预览静态服务不得再整文件读入内存");
}

testPreviewRequestGate();
testRangeParsing();
await testPreviewServerEndToEnd();
await testContentSecurityPolicy();
await testPreviewHandlerStaysStreaming();

console.log("=== fix security tests passed（预览闸门 / Range / CSP）===");
