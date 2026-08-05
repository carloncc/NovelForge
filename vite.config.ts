import { defineConfig, type Plugin, type Connect } from "vite";
import vue from "@vitejs/plugin-vue";
import { unzipSync } from "fflate";
import { readFile, readdir, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { join, dirname, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(ROOT, "src-tauri", "templates", "webgal");
const PREVIEW_DIR = "/tmp/novelforge-preview";

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

function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** 代理转发：浏览器无法直连厂商 API（CORS），由 dev/preview 服务器中转 */
async function handleProxy(req: Connect.IncomingMessage, res: Connect.ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let payload: { method?: string; url?: string; headers?: Record<string, string>; body?: string; timeoutSecs?: number };
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (payload.timeoutSecs ?? 120) * 1000);
    try {
      const resp = await fetch(payload.url, {
        method: payload.method ?? "GET",
        headers: payload.headers ?? {},
        body: payload.body || undefined,
        signal: controller.signal,
      });
      const buf = Buffer.from(await resp.arrayBuffer());
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
  if (!target.startsWith(normalize(TEMPLATE_DIR))) {
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
  const raw = await readBody(req);
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
    const safeName = normalize(payload.name).replace(/^\/+/, "").replace(/[^\w\-.]/g, "_");
    const dest = join(PREVIEW_DIR, safeName);
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    const files = unzipSync(Buffer.from(payload.zip, "base64"));
    for (const [path, data] of Object.entries(files)) {
      const full = normalize(join(dest, path));
      if (!full.startsWith(dest)) continue;
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, data);
    }
    const host = req.headers.host ?? "localhost";
    sendJson(res, 200, { url: `http://${host}/novelforge-preview/${safeName}/index.html` });
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message });
  }
}

/** 预览静态资源服务 */
async function handlePreviewStatic(req: Connect.IncomingMessage, res: Connect.ServerResponse): Promise<void> {
  const u = new URL(req.url ?? "/", "http://localhost");
  const rel = decodeURIComponent(u.pathname.replace(/^\/novelforge-preview\//, ""));
  const target = normalize(join(PREVIEW_DIR, rel));
  if (!target.startsWith(normalize(PREVIEW_DIR))) {
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
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}

function webPlugin(): Plugin {
  const mount = (server: { middlewares: Connect.Server }) => {
    server.middlewares.use("/__novelforge/proxy", (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }
      void handleProxy(req, res);
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
      void handlePreviewUpload(req, res);
    });
    server.middlewares.use("/novelforge-preview", (req, res) => {
      void handlePreviewStatic(req, res);
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
