import { defineConfig, type Plugin, type Connect } from "vite";
import vue from "@vitejs/plugin-vue";
import { unzipSync } from "fflate";
import { readFile, readdir, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
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
const PREVIEW_ZIP_LIMIT = 256 * 1024 * 1024;
const PREVIEW_EXPANDED_LIMIT = 1024 * 1024 * 1024;
const PREVIEW_FILE_LIMIT = 20_000;
const PREVIEW_FILE_SIZE_LIMIT = 256 * 1024 * 1024;
const PREVIEW_REQUEST_LIMIT = Math.ceil(PREVIEW_ZIP_LIMIT * 4 / 3) + 1024 * 1024;
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

async function handleModelRequest(req: Connect.IncomingMessage, res: Connect.ServerResponse): Promise<void> {
  const u = new URL(req.url ?? "/", "http://localhost");
  const pathname = u.pathname.replace(/^\/__novelforge\/model/, "") || "/";
  const modelId = u.searchParams.get("model") ?? "";
  const model = findCutoutModel(modelId);

  if (pathname === "/status") {
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

export function validateProxyUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid proxy URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("proxy protocol is not allowed");
  return url;
}

function authorize(req: Connect.IncomingMessage, res: Connect.ServerResponse): boolean {
  if (req.headers["x-novelforge-token"] !== SESSION_TOKEN) {
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
  const u = new URL(req.url ?? "/", "http://localhost");
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
  if (!payload.name || !payload.zip) {
    sendJson(res, 400, { error: "missing name/zip" });
    return;
  }
  try {
    const safeName = normalize(payload.name).replace(/^\/+/, "").replace(/[^\w\-.]/g, "_") || "game";
    const dest = join(PREVIEW_DIR, safeName);
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    const archive = Buffer.from(payload.zip, "base64");
    if (archive.byteLength > PREVIEW_ZIP_LIMIT) throw new Error("preview archive exceeds 256 MiB");
    let fileCount = 0;
    let expandedSize = 0;
    const files = unzipSync(archive, {
      filter(file) {
        fileCount++;
        expandedSize += file.originalSize;
        if (fileCount > PREVIEW_FILE_LIMIT) throw new Error("preview archive has too many files");
        if (file.originalSize > PREVIEW_FILE_SIZE_LIMIT) throw new Error(`preview file is too large: ${file.name}`);
        if (expandedSize > PREVIEW_EXPANDED_LIMIT) throw new Error("preview archive expands beyond 1 GiB");
        if (!isPathInside(dest, join(dest, file.name))) throw new Error(`unsafe preview path: ${file.name}`);
        return !file.name.endsWith("/");
      },
    });
    for (const [path, data] of Object.entries(files)) {
      const full = normalize(join(dest, path));
      if (!isPathInside(dest, full)) throw new Error(`unsafe preview path: ${path}`);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, data);
    }
    await ensurePreviewServer();
    sendJson(res, 200, { url: `http://127.0.0.1:${previewPort}/${encodeURIComponent(safeName)}/index.html` });
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message });
  }
}

/** 预览静态资源服务 */
async function handlePreviewStatic(req: Connect.IncomingMessage, res: Connect.ServerResponse): Promise<void> {
  const u = new URL(req.url ?? "/", "http://localhost");
  const rel = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
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
    const server = createServer((req, res) => { void handlePreviewStatic(req, res); });
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
  const u = new URL(req.url ?? "/", "http://localhost");
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
    server.middlewares.use("/onnx/", (req, res) => {
      void handleOnnxAsset(req, res);
    });
    server.middlewares.use("/__novelforge/proxy", (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }
      if (!authorize(req, res)) return;
      void handleProxy(req, res);
    });
    server.middlewares.use("/__novelforge/session", (req, res) => {
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.end();
        return;
      }
      sendJson(res, 200, { token: SESSION_TOKEN });
    });
    server.middlewares.use("/__novelforge/template", (req, res) => {
      void handleTemplate(req, res);
    });
    server.middlewares.use("/__novelforge/preview", (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }
      if (!authorize(req, res)) return;
      void handlePreviewUpload(req, res);
    });
    server.middlewares.use("/__novelforge/model", (req, res) => {
      void handleModelRequest(req, res);
    });
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
