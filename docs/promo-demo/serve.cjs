#!/usr/bin/env node
/**
 * 宣传 demo 静态服务器（零依赖，只用 Node 内置模块）。
 *
 * 为什么需要它：WebGAL 引擎入口是 `<script type="module">`，在 file:// 下 origin 为 null，
 * 会被浏览器 CORS 拦死（引擎自己也会弹「无法直接双击打开本游戏」提示页）。
 * 所以**必须**走 http://127.0.0.1 打开，不能双击 index.html。
 * 本机 Python 安装已损坏（缺 Lib 目录），`python -m http.server` 不可用，故用 Node。
 *
 * 用法：
 *   node serve.cjs                  # 服务脚本所在目录，端口 8080
 *   node serve.cjs 8081             # 换端口
 *   node serve.cjs <目录> [端口]     # 换目录与端口
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

/** 默认根目录 = 本脚本所在目录（游戏组装到哪，就把 serve.cjs 放哪） */
const SCRIPT_DIR = __dirname;

/**
 * 没显式给目录时：优先服务脚本所在目录；若那里没有 index.html，
 * 但**恰好有一个**子目录里有 index.html（例如游戏组装到了 宣传demo\铁皮城堡\），
 * 就自动服务那个子目录。多个候选时不猜，保持脚本目录并让 404 自己说话。
 */
function autoDetectRoot() {
  if (fs.existsSync(path.join(SCRIPT_DIR, "index.html"))) return SCRIPT_DIR;
  let candidates = [];
  try {
    candidates = fs
      .readdirSync(SCRIPT_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => path.join(SCRIPT_DIR, e.name))
      .filter((dir) => fs.existsSync(path.join(dir, "index.html")));
  } catch {
    return SCRIPT_DIR;
  }
  return candidates.length === 1 ? candidates[0] : SCRIPT_DIR;
}

function parseArgs(argv) {
  let root = autoDetectRoot();
  let port = 8080;
  const rest = argv.slice(2);
  if (rest.length === 1) {
    if (/^\d+$/.test(rest[0])) port = Number(rest[0]);
    else root = path.resolve(rest[0]);
  } else if (rest.length >= 2) {
    root = path.resolve(rest[0]);
    if (/^\d+$/.test(rest[1])) port = Number(rest[1]);
  }
  return { root, port };
}

/** 扩展名 → Content-Type。webp 只列一次（同一 MIME），另补 WebGAL 实际会用到的几类。 */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
  ".scss": "text/plain; charset=utf-8",
};

const contentTypeFor = (file) => MIME[path.extname(file).toLowerCase()] || "application/octet-stream";

/** 请求路径 → 磁盘绝对路径。越界（跳出根目录）返回 null。 */
function resolveSafe(root, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch {
    return null; // 非法百分号编码
  }
  if (rel.includes("\0")) return null;
  const abs = path.resolve(root, "." + path.posix.normalize(rel.replace(/\\/g, "/")));
  const relToRoot = path.relative(root, abs);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) return null;
  return abs;
}

const { root, port } = parseArgs(process.argv);

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const urlPath = req.url || "/";
  const stamp = () => new Date().toISOString().slice(11, 19);
  const finish = (status, note) => {
    // 每条请求一行日志：时间 方法 状态 路径 耗时（有备注就带上）
    console.log(`[${stamp()}] ${status} ${req.method} ${urlPath}${note ? `  ${note}` : ""}  ${Date.now() - started}ms`);
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
    res.end("405 Method Not Allowed");
    finish(405, "只允许 GET/HEAD");
    return;
  }

  const target = resolveSafe(root, urlPath);
  if (!target) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("403 Forbidden");
    finish(403, "路径越界");
    return;
  }

  let file = target;
  try {
    let st = await fsp.stat(file);
    // 目录索引：目录 → 目录下的 index.html
    if (st.isDirectory()) {
      file = path.join(file, "index.html");
      st = await fsp.stat(file);
    }
    if (!st.isFile()) throw new Error("not a file");

    const headers = {
      "Content-Type": contentTypeFor(file),
      "Content-Length": String(st.size),
      // 开发期一律不缓存：改完图/剧本刷新即生效，省得排查「为什么没变」
      "Cache-Control": "no-store",
    };
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      finish(200, `${st.size}B ${contentTypeFor(file)}`);
      return;
    }
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(file);
      stream.on("error", reject);
      stream.on("close", resolve);
      stream.pipe(res);
    });
    finish(200, `${st.size}B ${contentTypeFor(file)}`);
  } catch (e) {
    const notFound = e && (e.code === "ENOENT" || e.code === "ENOTDIR" || e.message === "not a file");
    res.writeHead(notFound ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(notFound ? "404 Not Found" : "500 Internal Server Error");
    finish(notFound ? 404 : 500, notFound ? "" : String((e && e.message) || e));
  }
});

server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") {
    console.error(`\n[错误] 端口 ${port} 已被占用：可能已经有一个 serve.cjs 在跑。`);
    console.error(`       直接打开 http://127.0.0.1:${port}/ 试试，或换端口：node serve.cjs ${port + 1}\n`);
  } else {
    console.error("[错误] 服务器启动失败：", e);
  }
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  console.log("");
  console.log("  宣传 demo 已启动（本地静态服务器，零依赖）");
  console.log(`  根目录：${root}`);
  console.log(`  地址：  http://127.0.0.1:${port}/`);
  console.log("");
  console.log("  关闭：在本窗口按 Ctrl+C");
  console.log("  ⚠ 不要双击 index.html —— file:// 会被浏览器 CORS 拦死，必须走上面的 http 地址。");
  console.log("");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，正在关闭服务器…`);
    server.close(() => process.exit(0));
    // 兜底：连接卡住时 1s 后强制退出
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
