import { defineConfig, type Plugin, type Connect } from "vite";
import vue from "@vitejs/plugin-vue";
import { Unzip, UnzipInflate } from "fflate";
import { readFile, readdir, mkdir, stat, rm } from "node:fs/promises";
import { closeSync, createReadStream, mkdirSync, openSync, writeSync } from "node:fs";
import { join, dirname, normalize, extname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { installModel, installedModelFile, modelPath } from "./scripts/web-model-downloader.mjs";
import { findCutoutModel, cutoutModelRemoteUrl } from "./src/core/cutout/models";

interface ModelInstallState {
  modelId: string | null;
  state: "idle" | "downloading" | "done" | "error";
  bytes: number;
  total: number;
  error: string | null;
}

const ROOT = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(ROOT, "src-tauri", "templates", "webgal");
const PREVIEW_DIR = join(tmpdir(), "novelforge-preview");
const SESSION_TOKEN = randomBytes(32).toString("hex");
const PROXY_BODY_LIMIT = 64 * 1024 * 1024;
const PROXY_RESPONSE_LIMIT = 64 * 1024 * 1024;
/** B118：以下上限是磁盘/文件数防线；流式解压后内存峰值不再随 zip 解压总大小增长 */
const PREVIEW_ZIP_LIMIT = 256 * 1024 * 1024;
const PREVIEW_EXPANDED_LIMIT = 1024 * 1024 * 1024;
const PREVIEW_FILE_LIMIT = 20_000;
const PREVIEW_FILE_SIZE_LIMIT = 256 * 1024 * 1024;
/** 预览上传请求体上限（zip 经 base64 约膨胀 4/3 倍 + JSON 包装余量）：
 * readBody 会按 content-length/累计长度在超限时尽早拒绝，不把超限请求读完整 */
const PREVIEW_REQUEST_LIMIT = Math.ceil(PREVIEW_ZIP_LIMIT * 4 / 3) + 1024 * 1024;
/** 流式解压时每次喂给 Unzip 的 base64 字符数：必须是 4 的倍数（4 字符 = 3 字节） */
const PREVIEW_B64_CHUNK = 256 * 1024;
let previewServer: HttpServer | undefined;
let previewPort = 0;

/** AI 抠图模型后台下载状态（web 运行时，/__novelforge/model 中间件） */
let modelInstallState: ModelInstallState = { modelId: null, state: "idle", bytes: 0, total: 0, error: null };

function modelStatusFor(modelId: string): ModelInstallState & { installed: boolean } {
  const active = modelInstallState.modelId === modelId;
  return {
    modelId,
    state: active ? modelInstallState.state : "idle",
    bytes: active ? modelInstallState.bytes : 0,
    total: active ? modelInstallState.total : 0,
    error: active ? modelInstallState.error : null,
    installed: installedModelFile(findCutoutModel(modelId).filename),
  };
}

/** 后台下载模型（不阻塞响应）；重复下载同一模型时直接返回当前状态 */
function spawnModelInstall(modelId: string): void {
  const model = findCutoutModel(modelId);
  if (modelInstallState.modelId === model.id && modelInstallState.state === "downloading") return;
  if (installedModelFile(model.filename)) {
    modelInstallState = { modelId: model.id, state: "done", bytes: 0, total: 0, error: null };
    return;
  }
  modelInstallState = { modelId: model.id, state: "downloading", bytes: 0, total: 0, error: null };
  void installModel(
    { filename: model.filename, url: cutoutModelRemoteUrl(model), md5: model.md5 ?? "" },
    { onProgress: ({ bytes, total }) => { modelInstallState.bytes = bytes; modelInstallState.total = total; } },
  )
    .then(() => {
      modelInstallState.state = "done";
      modelInstallState.error = null;
      console.log(`[model-download] 模型 ${model.id} 安装完成`);
    })
    .catch((error: unknown) => {
      modelInstallState.state = "error";
      modelInstallState.error = error instanceof Error ? error.message : String(error);
      console.error(`[model-download] 模型 ${model.id} 安装失败：${modelInstallState.error}`);
    });
}

/** 安全解析请求 URL：畸形请求目标（如原始 socket 发送非法绝对 URL）会抛 TypeError，
 * 不能让未捕获异常打死 dev/preview 进程（Node 15+ 未处理 rejection 默认终止进程）。 */
function parseRequestUrl(req: Connect.IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? "/", "http://localhost");
  } catch {
    return null;
  }
}

/** 中间件统一异常边界：async handler 的未捕获异常返回 500，而不是成为 unhandled rejection */
function safeHandler(
  handler: (req: Connect.IncomingMessage, res: Connect.ServerResponse) => Promise<void>,
): (req: Connect.IncomingMessage, res: Connect.ServerResponse) => void {
  return (req, res) => {
    handler(req, res).catch((e: unknown) => {
      console.error("[novelforge] middleware handler error:", e);
      if (!res.headersSent) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      } else {
        res.end();
      }
    });
  };
}

async function handleModelRequest(req: Connect.IncomingMessage, res: Connect.ServerResponse): Promise<void> {
  const u = parseRequestUrl(req);
  if (!u) {
    sendJson(res, 400, { error: "bad request" });
    return;
  }
  const pathname = u.pathname.replace(/^\/__novelforge\/model/, "") || "/";
  const modelId = u.searchParams.get("model") ?? "";
  const model = findCutoutModel(modelId);

  if (pathname === "/status") { if (!authorizeGet(req, res)) return;
    sendJson(res, 200, modelStatusFor(model.id));
    return;
  }
  if (pathname === "/install") {
    if (!authorize(req, res)) return;
    let raw: string;
    try {
      raw = await readBody(req, 64 * 1024);
    } catch (error) {
      sendJson(res, 413, { error: (error as Error).message });
      return;
    }
    let payload: { modelId?: string };
    try {
      payload = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    const target = findCutoutModel(payload.modelId ?? "");
    spawnModelInstall(target.id);
    sendJson(res, 200, modelStatusFor(target.id));
    return;
  }
  if (pathname === "/remove") {
    if (!authorize(req, res)) return;
    try {
      await rm(modelPath(model.filename), { force: true });
      await rm(`${modelPath(model.filename)}.part`, { force: true });
    } catch {
      /* 忽略删除失败 */
    }
    if (modelInstallState.modelId === model.id) {
      modelInstallState = { modelId: null, state: "idle", bytes: 0, total: 0, error: null };
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === "/file") {
    // B120：与 /status /install /remove 一致要求会话令牌（旧实现只查 isSameOriginRequest，
    // 本机其他进程可伪造 Host 头绕过）；onnxruntime-web 无法加请求头，故额外接受会话 Cookie
    if (!authorizeGet(req, res, true)) return;
    const file = modelPath(model.filename);
    try {
      await stat(file);
    } catch {
      res.statusCode = 404;
      res.end("model not found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", (await stat(file)).size);
    res.setHeader("Cache-Control", "no-cache");
    createReadStream(file).pipe(res);
    return;
  }
  res.statusCode = 404;
  res.end("not found");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".ico": "image/x-icon",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
};

function sendJson(res: Connect.ServerResponse, code: number, obj: unknown): void {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

function readBody(req: Connect.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new Error("request body too large"));
      return;
    }
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function isPathInside(base: string, target: string): boolean {
  const rel = relative(normalize(base), normalize(target));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

/** 私网/链路本地 IPv4 段（#791，纵深防御）：云元数据 169.254.0.0/16、RFC1918、CGNAT、0.0.0.0。
 *  回环（127.0.0.0/8）必须保留——Ollama 等本机模型服务依赖它。 */
function ipv4IsBlocked(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 127) return false;
  if (a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** IPv4 映射 IPv6 的两种写法：点分（::ffff:192.168.0.1）与 Node URL 归一化后的十六进制（::ffff:c0a8:1） */
function ipv4MappedIsBlocked(rest: string): boolean {
  if (rest.includes(".")) return ipv4IsBlocked(rest);
  const parts = rest.split(":");
  if (parts.length !== 2) return false;
  const hi = parseInt(parts[0], 16);
  const lo = parseInt(parts[1], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return false;
  return ipv4IsBlocked(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
}

/** 目标主机是否属于私网/链路本地（含 IPv6：fe80::/10、fc00::/7、IPv4 映射） */
function hostIsBlocked(hostname: string): boolean {
  let h = (hostname || "").toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost" || h === "::1") return false;
  if (h.includes(":")) {
    if (h.startsWith("::ffff:")) return ipv4MappedIsBlocked(h.slice(7));
    if (/^fe[89ab]/.test(h)) return true;
    if (/^f[cd]/.test(h)) return true;
    if (h === "::") return true;
    return false;
  }
  return ipv4IsBlocked(h);
}

export function validateProxyUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid proxy URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("proxy protocol is not allowed");
  if (hostIsBlocked(url.hostname)) throw new Error("proxy target host is not allowed");
  return url;
}

function isLocalHost(host: unknown): boolean { let h = String(host || "").toLowerCase(); if (h.startsWith("[")) { const end = h.indexOf("]"); h = end >= 0 ? h.slice(0, end + 1) : h.split(":")[0]; } else { h = h.split(":")[0]; } const name = h.replace(/^\[|\]$/g, ""); return name === "localhost" || name === "127.0.0.1" || name === "::1"; } function isSameOriginRequest(req: Connect.IncomingMessage): boolean { const host = req.headers.host; if (!host || !isLocalHost(host)) return false; const origin = req.headers.origin as string | undefined; const referer = req.headers.referer as string | undefined; const expectHttp = "http://" + host; const expectHttps = "https://" + host; if (origin && origin !== expectHttp && origin !== expectHttps) return false; if (!origin && referer) { try { const r = new URL(referer); if (r.host !== String(host)) return false; } catch { return false; } } return true; } /** B120：/file 的请求由 onnxruntime-web 内部 fetch 发出，无法附加 X-NovelForge-Token 头；
 * 因此 /session 会额外下发 SameSite=Strict 会话 Cookie，这里作为等价凭据读取
 * （同源自动携带，跨站子请求不会发送）。 */
function readSessionCookie(req: Connect.IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === "novelforge_session") return part.slice(eq + 1).trim();
  }
  return undefined;
}
function authorizeGet(req: Connect.IncomingMessage, res: Connect.ServerResponse, allowSessionCookie = false): boolean {
  if (!isLocalHost(req.headers.host)) { sendJson(res, 403, { error: "forbidden" }); return false; }
  const hasToken = req.headers["x-novelforge-token"] === SESSION_TOKEN
    || (allowSessionCookie && readSessionCookie(req) === SESSION_TOKEN);
  if (!hasToken) { sendJson(res, 403, { error: "forbidden" }); return false; }
  if (!isSameOriginRequest(req)) { sendJson(res, 403, { error: "invalid origin" }); return false; }
  return true;
}
function authorize(req: Connect.IncomingMessage, res: Connect.ServerResponse): boolean {
  if (!isLocalHost(req.headers.host)) { sendJson(res, 403, { error: "forbidden" }); return false; } if (req.headers["x-novelforge-token"] !== SESSION_TOKEN) {
    sendJson(res, 403, { error: "forbidden" });
    return false;
  }
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host && origin !== `http://${host}` && origin !== `https://${host}`) {
    sendJson(res, 403, { error: "invalid origin" });
    return false;
  }
  if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    sendJson(res, 415, { error: "application/json required" });
    return false;
  }
  return true;
}

async function readLimitedResponse(resp: Response): Promise<Buffer> {
  const declared = Number(resp.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > PROXY_RESPONSE_LIMIT) throw new Error("proxy response too large");
  if (!resp.body) return Buffer.alloc(0);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PROXY_RESPONSE_LIMIT) {
      await reader.cancel();
      throw new Error("proxy response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** 代理转发：浏览器无法直连厂商 API（CORS），由 dev/preview 服务器中转 */
async function handleProxy(req: Connect.IncomingMessage, res: Connect.ServerResponse): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req, PROXY_BODY_LIMIT);
  } catch (error) {
    sendJson(res, 413, { error: (error as Error).message });
    return;
  }
  let payload: { method?: string; url?: string; headers?: Record<string, string>; body?: string; bodyBase64?: string; timeoutSecs?: number };
  try {
    payload = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "bad request" });
    return;
  }
  if (!payload.url) {
    sendJson(res, 400, { error: "missing url" });
    return;
  }
  try {
    const target = validateProxyUrl(payload.url);
    const controller = new AbortController();
    const timeoutSecs = Math.max(1, Math.min(600, payload.timeoutSecs ?? 120));
    const timer = setTimeout(() => controller.abort(), timeoutSecs * 1000);
    try {
      const blockedHeaders = /^(host|connection|content-length|transfer-encoding|cookie|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|upgrade)$/i;
      const headers = Object.fromEntries(Object.entries(payload.headers ?? {}).filter(([name]) => !blockedHeaders.test(name)));
      const requestBody = typeof payload.bodyBase64 === "string"
        ? Buffer.from(payload.bodyBase64, "base64")
        : payload.body || undefined;
      const resp = await fetch(target, {
        method: payload.method ?? "GET",
        headers,
        body: requestBody,
        signal: controller.signal,
        redirect: "manual",
      });
      const buf = await readLimitedResponse(resp);
      sendJson(res, 200, {
        status: resp.status,
        contentType: resp.headers.get("content-type") || "",
        bodyBase64: buf.toString("base64"),
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    sendJson(res, 502, { error: (e as Error).message });
  }
}

/** 模板资源：浏览器按需从 dev server 拉取 WebGAL 引擎文件 */
async function handleTemplate(req: Connect.IncomingMessage, res: Connect.ServerResponse): Promise<void> {
  const u = parseRequestUrl(req);
  if (!u) {
    sendJson(res, 400, { error: "bad request" });
    return;
  }
  const rel = (u.searchParams.get("path") ?? "").replace(/^\/+/, "");
  const target = normalize(join(TEMPLATE_DIR, rel));
  if (!isPathInside(TEMPLATE_DIR, target)) {
    sendJson(res, 400, { error: "invalid path" });
    return;
  }
  try {
    const st = await stat(target);
    if (st.isDirectory()) {
      const entries = await readdir(target);
      const out = [];
      for (const name of entries) {
        if (name.startsWith(".")) continue;
        const child = await stat(join(target, name));
        out.push({
          name,
          path: `${rel ? "/" + rel : ""}/${name}`,
          isDir: child.isDirectory(),
          size: child.size,
        });
      }
      sendJson(res, 200, { kind: "dir", entries: out });
    } else {
      const buf = await readFile(target);
      sendJson(res, 200, { kind: "file", base64: buf.toString("base64") });
    }
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

/** B118：流式解压预览 zip 并逐文件写盘。
 * 旧实现 unzipSync 会先把全部文件解压进内存对象再逐个写盘，峰值是
 * 「JSON 整串 + base64 全量 Buffer + 全量解压对象」三份叠加（极端情况数百 MB）。
 * 现在按 PREVIEW_B64_CHUNK 分块解码 → fflate 流式 Unzip → 单文件边解压边写盘：
 * 内存峰值降为两份（JSON.parse 期间的整串 + payload.zip），单文件占用与文件大小无关。 */
async function extractPreviewZip(zipBase64: string, dest: string): Promise<void> {
  // body 上限允许 base64 略高于 zip 上限（含 JSON 包装余量），这里按解码后大小精确复核
  if (zipBase64.length > Math.ceil(PREVIEW_ZIP_LIMIT * 4 / 3)) {
    throw new Error("preview archive exceeds 256 MiB");
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let fileCount = 0;
    let expandedSize = 0;
    let openFd: number | null = null;
    let openFileSize = 0;

    const closeOpenFd = (): void => {
      if (openFd === null) return;
      try {
        closeSync(openFd);
      } catch {
        /* 关闭失败无需处理 */
      }
      openFd = null;
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      closeOpenFd();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const unzip = new Unzip((file) => {
      if (settled) return;
      if (file.name.endsWith("/")) {
        // 目录条目不写盘（文件写盘前会 mkdir 父目录）
        file.ondata = () => {};
        file.start();
        return;
      }
      try {
        fileCount++;
        if (fileCount > PREVIEW_FILE_LIMIT) throw new Error("preview archive has too many files");
        const full = normalize(join(dest, file.name));
        if (!isPathInside(dest, full)) throw new Error(`unsafe preview path: ${file.name}`);
        mkdirSync(dirname(full), { recursive: true });
        closeOpenFd(); // 防御损坏 zip 时上一文件未收到 final 导致的 fd 泄漏
        openFd = openSync(full, "w");
        openFileSize = 0;
      } catch (error) {
        fail(error);
        return;
      }
      file.ondata = (error, chunk, final) => {
        if (settled) return;
        try {
          if (error) throw error;
          if (chunk.length > 0) {
            openFileSize += chunk.length;
            expandedSize += chunk.length;
            if (openFileSize > PREVIEW_FILE_SIZE_LIMIT) throw new Error(`preview file is too large: ${file.name}`);
            if (expandedSize > PREVIEW_EXPANDED_LIMIT) throw new Error("preview archive expands beyond 1 GiB");
            if (openFd !== null) writeSync(openFd, chunk);
          }
          if (final) closeOpenFd();
        } catch (writeError) {
          fail(writeError);
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);

    const total = zipBase64.length;
    const step = (offset: number): void => {
      if (settled) return;
      try {
        const end = Math.min(offset + PREVIEW_B64_CHUNK, total);
        const chunk = Buffer.from(zipBase64.slice(offset, end), "base64");
        // fflate 流式解压对非 zip 数据不报错，这里显式校验 ZIP 签名（PK\x03\x04 / PK\x05\x06）
        if (offset === 0 && (chunk.length < 4 || chunk[0] !== 0x50 || chunk[1] !== 0x4b)) {
          throw new Error("preview archive is not a valid zip");
        }
        unzip.push(chunk, end >= total);
        if (settled) return;
        if (end >= total) {
          settled = true;
          resolve();
        } else {
          // 分块解压+写盘是同步 CPU/IO：让出事件循环，避免长时间阻塞 dev server
          setImmediate(() => step(end));
        }
      } catch (error) {
        fail(error);
      }
    };
    step(0);
  });
}

/** 预览：接收前端 zip 打包的游戏 → 解压到临时目录 → 返回访问 URL */
async function handlePreviewUpload(req: Connect.IncomingMessage, res: Connect.ServerResponse): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req, PREVIEW_REQUEST_LIMIT);
  } catch (error) {
    sendJson(res, 413, { error: (error as Error).message });
    return;
  }
  let payload: { name?: string; zip?: string };
  try {
    payload = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "bad request" });
    return;
  }
  // B118：尽早释放完整请求串引用，后续只保留 payload.zip 一份大字符串
  raw = "";
  if (!payload.name || !payload.zip) {
    sendJson(res, 400, { error: "missing name/zip" });
    return;
  }
  try {
    const safeName = normalize(payload.name).replace(/^\/+/, "").replace(/[^\w\-.]/g, "_") || "game";
    // 目录名必须落在 PREVIEW_DIR 内部：`..` 会被 normalize 保留，join 后即父目录，
    // 随后的 rm(recursive) 会递归删除系统临时目录（破坏性路径穿越）
    const dest = join(PREVIEW_DIR, safeName);
    if (safeName === "." || safeName === ".." || normalize(dest) === normalize(PREVIEW_DIR) || !isPathInside(PREVIEW_DIR, dest)) {
      sendJson(res, 400, { error: "invalid name" });
      return;
    }
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    // 分块解码 + 流式解压 + 逐文件写盘（B118，不再整块 Buffer.from 与 unzipSync）
    await extractPreviewZip(payload.zip, dest);
    await ensurePreviewServer();
    sendJson(res, 200, { url: `http://127.0.0.1:${previewPort}/${encodeURIComponent(safeName)}/index.html` });
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message });
  }
}

/** 预览静态资源服务 */
async function handlePreviewStatic(req: Connect.IncomingMessage, res: Connect.ServerResponse): Promise<void> {
  const u = parseRequestUrl(req);
  if (!u) {
    res.statusCode = 400;
    res.end("bad request");
    return;
  }
  let rel: string;
  try {
    rel = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
  } catch {
    // 畸形百分号编码（%zz、%E4% 等）：400 而不是未捕获异常终止进程
    res.statusCode = 400;
    res.end("bad encoding");
    return;
  }
  const target = normalize(join(PREVIEW_DIR, rel));
  if (!isPathInside(PREVIEW_DIR, target)) {
    res.statusCode = 400;
    res.end("bad path");
    return;
  }
  try {
    let full = target;
    const st = await stat(full);
    if (st.isDirectory()) {
      full = join(full, "index.html");
    }
    const buf = await readFile(full);
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[extname(full)] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}

function ensurePreviewServer(): Promise<void> {
  if (previewServer && previewPort) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const server = createServer(safeHandler(handlePreviewStatic));
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("preview server did not expose a TCP port"));
        return;
      }
      previewServer = server;
      previewPort = address.port;
      resolve();
    });
  });
}

/** onnxruntime-web 运行时资源：绕过 vite 模块转换按静态文件原样返回。
 * ort 推理时会动态 import() /onnx/*.mjs 胶水模块；public 文件被当作模块加载时
 * vite dev 会报“public 文件不应从源码 import”。此中间件提前接管 /onnx/ 请求。
 * （生产构建仍走 public 目录拷贝后的静态托管，行为不变。） */
async function handleOnnxAsset(req: Connect.IncomingMessage, res: Connect.ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.end();
    return;
  }
  const u = parseRequestUrl(req);
  if (!u) {
    res.statusCode = 400;
    res.end("bad request");
    return;
  }
  const rel = u.pathname.replace(/^\/onnx\//, "");
  if (rel === "" || !/^[\w.-]+$/.test(rel)) {
    res.statusCode = 400;
    res.end("bad path");
    return;
  }
  const file = join(ROOT, "public", "onnx", rel);
  try {
    const buf = await readFile(file);
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "no-cache");
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(buf);
    }
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}

function webPlugin(): Plugin {
  const mount = (server: { middlewares: Connect.Server }) => {
    server.middlewares.use("/onnx/", safeHandler(handleOnnxAsset));
    server.middlewares.use("/__novelforge/proxy", (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }
      if (!authorize(req, res)) return;
      safeHandler(handleProxy)(req, res);
    });
    server.middlewares.use("/__novelforge/session", (req, res) => {
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.end();
        return;
      }
      if (!isSameOriginRequest(req)) { sendJson(res, 403, { error: "forbidden" }); return; }
      // B120：一并下发会话 Cookie，供 onnxruntime-web 加载 /model/file 时携带（它无法自定义请求头）。
      // SameSite=Strict：仅同站请求自动携带，跨站请求不会带上；HttpOnly 防止脚本读取。
      res.setHeader("Set-Cookie", `novelforge_session=${SESSION_TOKEN}; Path=/; SameSite=Strict; HttpOnly`);
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, 200, { token: SESSION_TOKEN });
    });
    server.middlewares.use("/__novelforge/template", (req, res) => { if (!authorizeGet(req, res)) return;
      safeHandler(handleTemplate)(req, res);
    });
    server.middlewares.use("/__novelforge/preview", (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }
      if (!authorize(req, res)) return;
      safeHandler(handlePreviewUpload)(req, res);
    });
    server.middlewares.use("/__novelforge/model", safeHandler(handleModelRequest));
    server.httpServer?.once("close", () => {
      previewServer?.close();
      previewServer = undefined;
      previewPort = 0;
    });
  };
  return {
    name: "novelforge-web",
    configureServer(server) {
      mount(server);
    },
    configurePreviewServer(server) {
      mount(server);
    },
  };
}

export default defineConfig({
  plugins: [vue(), webPlugin()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2021",
    chunkSizeWarningLimit: 2048,
  },
  envPrefix: ["VITE_", "TAURI_"],
});
