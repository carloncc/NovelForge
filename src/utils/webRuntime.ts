/**
 * 浏览器（非 Tauri）运行时实现。
 * - HTTP：经同源代理 /__novelforge/proxy（dev/preview server 提供，规避 CORS）
 * - 文件：IndexedDB 虚拟 FS；/app/template 首次访问从 dev server 同步缓存
 * - 预览：前端 zip 打包 → 上传 /__novelforge/preview → 解压静态服务
 * - 抠图：canvas 四角 flood-fill 去背景
 */
import { zipSync } from "fflate";
import type { CutoutModelDownloadRequest, CutoutModelStatus, FsEntry, HttpResult } from "./tauri";
import * as vfs from "./vfsWeb";
import { log } from "./logger";
import { errMsg } from "./errors";
import { b64encode } from "./base64";
import { t } from "../i18n";

const PROXY_URL = "/__novelforge/proxy";
const TEMPLATE_URL = "/__novelforge/template";
const PREVIEW_URL = "/__novelforge/preview";
const SESSION_URL = "/__novelforge/session";
const MODEL_URL = "/__novelforge/model";
const TEMPLATE_ROOT = "/app/template";
const WEB_RESPONSE_LIMIT = 64 * 1024 * 1024;
let sessionTokenPromise: Promise<string> | undefined;

function webSessionToken(forceRenew = false): Promise<string> {
  // B96：403 表示 token 过期/被 dev server 重启丢弃，必须强制重取而不是继续复用旧 Promise
  if (forceRenew) sessionTokenPromise = undefined;
  sessionTokenPromise ??= fetch(SESSION_URL, { method: "GET", credentials: "same-origin" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Web session unavailable ${response.status}`);
      const data = await response.json() as { token?: string };
      if (!data.token) throw new Error("Web session token missing");
      return data.token;
    })
    .catch((error) => {
      // B96：失败的 Promise 绝不能留在缓存里：旧实现一次取 token 失败（网络抖动/服务未就绪）
      // 会让之后所有请求都复用同一个 rejected Promise，永久失效直到刷新页面。
      sessionTokenPromise = undefined;
      throw error;
    });
  return sessionTokenPromise;
}

/**
 * 代理已返回 HTTP 响应时的错误标记（B97）。
 * 这类失败说明请求已经真实发给厂商（可能已完成/已计费），绝不能回退直连重发。
 */
class ProxyHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProxyHttpError";
  }
}

function b64decode(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ============ HTTP（同源代理，规避厂商 CORS） ============ */

export async function webHttp(args: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  timeoutSecs?: number;
}): Promise<HttpResult> {
  if (!/^https?:\/\//i.test(args.url)) {
    throw new Error(t("仅支持 HTTP/HTTPS API 地址"));
  }
  try {
    const send = async (token: string) => fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-NovelForge-Token": token },
      body: JSON.stringify({
        method: args.method,
        url: args.url,
        headers: args.headers ?? {},
        body: args.body ?? "",
        bodyBase64: args.bodyBase64,
        timeoutSecs: args.timeoutSecs ?? 120,
      }),
    });
    let resp = await send(await webSessionToken());
    if (resp.status === 403) {
      // B96：token 过期/失效时强制重取一次并重放（仅一次，避免死循环）
      log.warn("webRuntime", "代理返回 403，刷新会话 token 后重放一次", { url: args.url });
      resp = await send(await webSessionToken(true));
    }
    if (!resp.ok) {
      let detail = "";
      try {
        detail = (await resp.text()).slice(0, 300);
      } catch {
        /* 响应体读取失败时只报状态码 */
      }
      // HTTP 状态码保留数字：仅包裹文案模板，{status} 由 t() 插值
      const message = [400, 403, 413, 415].includes(resp.status)
        ? t("代理拒绝请求 {status}{detail}", { status: resp.status, detail: detail ? `：${detail}` : "" })
        : t("代理不可用 {status}{detail}", { status: resp.status, detail: detail ? `：${detail}` : "" });
      // B97：代理已返回 HTTP 响应 = 请求已真实发往厂商，不能回退直连重发（付费 POST 会被执行两次）
      throw new ProxyHttpError(message, resp.status);
    }
    const json = (await resp.json()) as { status: number; contentType: string; bodyBase64: string };
    return { status: json.status, contentType: json.contentType, bodyBase64: json.bodyBase64 };
  } catch (e) {
    // B97：只有网络层异常（fetch reject，请求根本没送到代理）才允许直连兜底
    if (e instanceof ProxyHttpError) throw e;
    log.warn("webRuntime", "同源代理网络层失败，尝试直连", { url: args.url, error: errMsg(e) });
    return directFetch(args);
  }
}

async function directFetch(args: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  timeoutSecs?: number;
}): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (args.timeoutSecs ?? 120) * 1000);
  try {
    const resp = await fetch(args.url, {
      method: args.method,
      headers: args.headers,
      body: args.bodyBase64 ? b64decode(args.bodyBase64) : args.body,
      signal: controller.signal,
    });
    const buf = await readLimitedWebResponse(resp);
    return {
      status: resp.status,
      contentType: resp.headers.get("content-type") || "",
      bodyBase64: b64encode(buf),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ============ 模板资源同步（dev server → IndexedDB 缓存） ============ */

async function fetchTemplateNode(rel: string): Promise<{ kind: "file"; base64: string } | { kind: "dir"; entries: FsEntry[] } | undefined> {
  let token = ""; try { token = await webSessionToken(); } catch { return undefined; } const resp = await fetch(`${TEMPLATE_URL}?path=${encodeURIComponent(rel)}`, { method: "GET", headers: { "X-NovelForge-Token": token } });
  if (!resp.ok) return undefined;
  return (await resp.json()) as { kind: "file"; base64: string } | { kind: "dir"; entries: FsEntry[] };
}

/** 确保模板树中某路径已缓存到虚拟 FS（递归拉取） */
async function ensureTemplateLocal(path: string): Promise<void> {
  const normalized = path.replace(/\/+$/, "");
  if (!normalized.startsWith(TEMPLATE_ROOT)) return;
  if (await vfs.vfsExists(normalized)) return;
  const rel = normalized.slice(TEMPLATE_ROOT.length + 1);
  const node = await fetchTemplateNode(rel);
  if (!node) return;
  if (node.kind === "dir") {
    await vfs.vfsMkdirAll(normalized);
    for (const e of node.entries) {
      await ensureTemplateLocal(`${normalized}/${e.name}`);
    }
  } else {
    await vfs.vfsWriteFileBase64(normalized, node.base64);
  }
}

/** 确保整个模板树已缓存（目录遍历） */
async function ensureTemplateTree(): Promise<void> {
  const index = `${TEMPLATE_ROOT}/index.html`;
  if (await vfs.vfsExists(index)) return;
  log.info("webRuntime", "开始同步模板树到 IndexedDB", { root: TEMPLATE_ROOT });
  await ensureTemplateLocal(TEMPLATE_ROOT);
  log.info("webRuntime", "模板树同步完成");
}

/* ============ 文件操作 ============ */

export async function webReadTextFile(path: string): Promise<{ text: string; encoding: string }> {
  if (path.startsWith(TEMPLATE_ROOT + "/")) await ensureTemplateLocal(path);
  const text = await vfs.vfsReadTextFile(path);
  if (text === undefined) throw new Error(t("文件不存在：{path}", { path }));
  return { text, encoding: "UTF-8" };
}

export async function webReadFileBase64(path: string): Promise<string> {
  if (path.startsWith(TEMPLATE_ROOT + "/")) await ensureTemplateLocal(path);
  const b64 = await vfs.vfsReadFileBase64(path);
  if (b64 === undefined) throw new Error(t("文件不存在：{path}", { path }));
  return b64;
}

export async function webWriteTextFile(path: string, content: string): Promise<void> {
  await vfs.vfsWriteTextFile(path, content);
}

export async function webWriteFileBase64(path: string, dataB64: string): Promise<void> {
  await vfs.vfsWriteFileBase64(path, dataB64);
}

export async function webListDir(path: string): Promise<FsEntry[]> {
  if (path.startsWith(TEMPLATE_ROOT + "/")) await ensureTemplateLocal(path);
  if (!path.startsWith(TEMPLATE_ROOT)) {
    // 业务目录直接来自虚拟 FS
    return vfs.vfsListDir(path);
  }
  const rel = path.slice(TEMPLATE_ROOT.length + 1);
  const node = await fetchTemplateNode(rel);
  if (node?.kind === "dir") return node.entries;
  return vfs.vfsListDir(path);
}

export async function webPathExists(path: string): Promise<boolean> {
  if (path.startsWith(TEMPLATE_ROOT + "/")) {
    if (await vfs.vfsExists(path)) return true;
    if (!path.endsWith("/index.html") && (await vfs.vfsExists(`${path}/index.html`))) return true;
    const rel = path.slice(TEMPLATE_ROOT.length + 1);
    // 只为模板根的直接子项做远端探测（模板解析校验所需）；深层路径同步前一律视为不存在，
    // 否则候选路径探测会给浏览器控制台刷一串 404。深层路径由读取/复制时的 ensureTemplateLocal 懒同步。
    if (!rel || rel.includes("/")) return false;
    const node = await fetchTemplateNode(rel);
    return node !== undefined;
  }
  return vfs.vfsExists(path);
}

export async function webCopyFile(src: string, dst: string): Promise<void> {
  if (src.startsWith(TEMPLATE_ROOT + "/")) await ensureTemplateLocal(src);
  await vfs.vfsCopyFile(src, dst);
}

export async function webCopyDirAll(src: string, dst: string): Promise<void> {
  if (src.startsWith(TEMPLATE_ROOT + "/")) await ensureTemplateLocal(src);
  await vfs.vfsCopyDirAll(src, dst);
}

async function readLimitedWebResponse(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > WEB_RESPONSE_LIMIT) throw new Error("HTTP response too large");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > WEB_RESPONSE_LIMIT) {
      await reader.cancel();
      throw new Error("HTTP response too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function webReplacePath(src: string, dst: string): Promise<void> {
  await vfs.vfsReplacePath(src, dst);
}

export async function webMkdirAll(path: string): Promise<void> {
  await vfs.vfsMkdirAll(path);
}

export async function webRemovePath(path: string): Promise<void> {
  await vfs.vfsRemove(path);
}

/* ============ 配置（localStorage 持久化） ============ */

const CONFIG_KEY = "novelforge:config";
const SECRET_KEY = "novelforge:api-secrets";

export async function webReadConfig(): Promise<string> {
  return localStorage.getItem(CONFIG_KEY) ?? "{}";
}

export async function webWriteConfig(content: string): Promise<void> {
  localStorage.setItem(CONFIG_KEY, content);
}

export async function webReadApiSecrets(ids: string[]): Promise<Record<string, string>> {
  let stored: Record<string, string> = {};
  try {
    stored = JSON.parse(sessionStorage.getItem(SECRET_KEY) ?? "{}") as Record<string, string>;
  } catch {
    sessionStorage.removeItem(SECRET_KEY);
  }
  return Object.fromEntries(
    ids.filter((id) => Object.prototype.hasOwnProperty.call(stored, id)).map((id) => [id, stored[id]]),
  );
}

export async function webWriteApiSecrets(secrets: Record<string, string>): Promise<void> {
  let stored: Record<string, string> = {};
  try {
    stored = JSON.parse(sessionStorage.getItem(SECRET_KEY) ?? "{}") as Record<string, string>;
  } catch {
    stored = {};
  }
  for (const [id, secret] of Object.entries(secrets)) {
    if (secret) stored[id] = secret;
    else delete stored[id];
  }
  sessionStorage.setItem(SECRET_KEY, JSON.stringify(stored));
}

/* ============ 预览（zip 上传 → dev server 解压静态服务） ============ */

export async function webStartPreviewServer(root: string): Promise<{ url: string; port: number }> {
  log.info("webRuntime", "web 预览启动", { root });
  await ensureTemplateTree();
  const files = await vfs.vfsCollectFiles(root, [`${root}/.novel2vn`]);
  if (!files.length) throw new Error(t("预览失败：目录为空（{path}）", { path: root }));
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.path] = new Uint8Array(f.data);
  const zipData = zipSync(entries);
  const name = root.split("/").filter(Boolean).pop() || "game";
  const token = await webSessionToken();
  const resp = await fetch(PREVIEW_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-NovelForge-Token": token },
    body: JSON.stringify({ name, zip: b64encode(zipData) }),
  });
  if (!resp.ok) throw new Error(t("预览上传失败 {status}", { status: resp.status }));
  const json = (await resp.json()) as { url: string };
  log.info("webRuntime", "web 预览就绪", { url: json.url, files: files.length });
  return { url: json.url, port: 0 };
}

/* ============ 打包 zip（导出页面） ============ */

/** 已压缩的媒体/字体文件：直接 store，不再浪费 CPU 二次压缩（大项目能快一个数量级） */
const ZIP_MEDIA_RE = /\.(png|jpe?g|webp|gif|mp4|webm|mp3|ogg|opus|wav|flac|m4a|ttf|otf|woff2?)$/i;

/** 在专用 Worker 中压缩（浏览器）；Node（单测）无 Worker 时回退同步压缩 */
function zipEntries(entries: Record<string, [Uint8Array, { level: 0 | 6 }]>): Promise<Uint8Array> {
  if (typeof Worker === "undefined") {
    return Promise.resolve(zipSync(entries));
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./zipWorker.ts", import.meta.url), { type: "module" });
    } catch {
      resolve(zipSync(entries));
      return;
    }
    worker.onmessage = (ev: MessageEvent<{ data?: ArrayBuffer; error?: string }>) => {
      worker.terminate();
      if (ev.data?.error) reject(new Error(ev.data.error));
      else resolve(new Uint8Array(ev.data.data!));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || t("zip worker 执行失败")));
    };
    worker.postMessage({ entries });
  });
}

export async function webBuildZip(
  sourceDir: string,
  _zipPath: string,
  exclude: string[],
): Promise<{ fileCount: number; sizeBytes: number; data: Uint8Array }> {
  const files = await vfs.vfsCollectFiles(sourceDir, exclude);
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const f of files) {
    entries[f.path] = [new Uint8Array(f.data), { level: ZIP_MEDIA_RE.test(f.path) ? 0 : 6 }];
  }
  const zipData = await zipEntries(entries);
  return { fileCount: files.length, sizeBytes: zipData.byteLength, data: zipData };
}

/** 网页版导出：压缩后直接触发浏览器下载（应用层调用，字节不经日志包装） */
export async function webDownloadZip(
  sourceDir: string,
  exclude: string[],
  downloadName: string,
): Promise<{ fileCount: number; sizeBytes: number }> {
  const { fileCount, sizeBytes, data } = await webBuildZip(sourceDir, "", exclude);
  vfs.vfsDownloadBytes(data, downloadName, "application/zip");
  return { fileCount, sizeBytes };
}

/* ============ 抠图（canvas 四角 flood-fill 去背景） ============ */

/* ============ AI 抠图模型下载（dev/preview server 的 /__novelforge/model 中间件） ============ */

export async function webCutoutModelStatus(modelId: string, filename: string): Promise<CutoutModelStatus> {
  const fallback: CutoutModelStatus = { modelId, state: "idle", bytes: 0, total: 0, error: null, installed: false };
  try {
    const stoken = await webSessionToken(); const resp = await fetch(`${MODEL_URL}/status?model=${encodeURIComponent(modelId)}`, { method: "GET", headers: { "X-NovelForge-Token": stoken } });
    if (!resp.ok) return fallback;
    return (await resp.json()) as CutoutModelStatus;
  } catch {
    return fallback;
  }
}

export async function webCutoutModelDownload(req: CutoutModelDownloadRequest): Promise<CutoutModelStatus> {
  const token = await webSessionToken();
  const resp = await fetch(`${MODEL_URL}/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-NovelForge-Token": token },
    body: JSON.stringify(req),
  });
  if (!resp.ok) throw new Error(t("模型下载启动失败 {status}", { status: resp.status }));
  return (await resp.json()) as CutoutModelStatus;
}

export async function webCutoutModelRemove(modelId: string, filename: string): Promise<void> {
  const token = await webSessionToken();
  const resp = await fetch(`${MODEL_URL}/remove?model=${encodeURIComponent(modelId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-NovelForge-Token": token },
    body: JSON.stringify({}),
  });
  if (!resp.ok) throw new Error(t("模型删除失败 {status}", { status: resp.status }));
}

/* ============ 抠图（canvas 四角 flood-fill 去背景） ============ */

async function loadImage(dataB64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t("图片解码失败")));
    img.src = `data:image/png;base64,${dataB64}`;
  });
}

export async function webHasTransparency(dataB64: string): Promise<boolean> {
  try {
    const img = await loadImage(dataB64);
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return true;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // 与桌面版（Rust has_transparency）对齐：alpha<16 的像素占比 >5% 才算「已透明」。
    // 旧实现「任一 alpha<250 即已透明」会让 AI 常返回的边缘半透明 PNG 直接跳过抠图、绿幕整片残留。
    let low = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 16) low++;
    }
    return low / Math.max(1, data.length / 4) > 0.05;
  } catch {
    return true;
  }
}

/** 色度键抠图（对齐 Rust 实现）：边缘采样背景色 → 从四边 flood-fill 连通约束 → 边缘羽化。
 *  只移除与边缘相连的背景区域，主体内部与背景相近的孤立像素（如脸部高光）不会被误删。
 *  绿幕下启用色度加权距离（降 G 权重）+ 暗色前景保护（max(rgb)<60 当前景边界），
 *  对齐 Rust cutout.rs 行为，避免「绿底把黑色抠成灰色半透明」。 */
export async function webCutoutImage(dataB64: string, threshold = 40): Promise<{ dataB64: string; method: string }> {
  try {
    const img = await loadImage(dataB64);
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { dataB64, method: "chroma" };
    ctx.drawImage(img, 0, 0);
    const w = canvas.width;
    const h = canvas.height;
    const imageData = ctx.getImageData(0, 0, w, h);
    const px = imageData.data;
    const visited = new Uint8Array(w * h);

    // 背景参考色：边缘一圈采样，取各通道中位数（抗前景人物干扰）
    const ring = 6;
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    const pushPx = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      if (px[i + 3] > 240) {
        rs.push(px[i]);
        gs.push(px[i + 1]);
        bs.push(px[i + 2]);
      }
    };
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < ring; y++) {
        pushPx(x, y);
        pushPx(x, h - 1 - y);
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < ring; x++) {
        pushPx(x, y);
        pushPx(w - 1 - x, y);
      }
    }
    if (rs.length < 8) return { dataB64, method: "chroma" };
    const median = (v: number[]) => v.slice().sort((a, b) => a - b)[(v.length / 2) | 0];
    const bgR = median(rs);
    const bgG = median(gs);
    const bgB = median(bs);

    // 绿幕识别（对齐 Rust is_green_screen）
    const green =
      bgG >= 60 &&
      (bgG - Math.max(bgR, bgB) > 30 ||
        (bgB > bgR + 15 && bgG >= bgB - 15) ||
        (bgG > bgR + 10 && bgG > bgB + 10 && bgG >= (bgR + bgB) * 0.55));
    // 深色背景（黑/墨蓝）：色度键无法区分黑发/黑衣与深色背景，硬抠会把主体抠成半透明灰 → 保留原图（对齐 Rust）
    if (!green && Math.max(bgR, bgG, bgB) < 90) {
      return { dataB64, method: "skip-dark" };
    }

    // 绿幕下用更大容差与色度加权距离（降 G 权重）
    const thr = green ? Math.max(threshold, 80) : Math.max(threshold, 4);
    const thrEdge = green ? thr + 90 : thr + 40;

    const dist = (i: number) => {
      const dr = px[i] - bgR;
      const dg = px[i + 1] - bgG;
      const db = px[i + 2] - bgB;
      if (green) {
        // 色度加权：G 权重 0.25（对齐 Rust）
        return Math.sqrt(dr * dr + db * db + dg * dg * 0.25);
      }
      return Math.sqrt(dr * dr + dg * dg + db * db);
    };

    const DARK_FG_THRESH = 96;
    const isDarkFg = (i: number) => {
      if (!green) return false;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      return Math.max(r, g, b) < DARK_FG_THRESH;
    };

    // 从四条边播种 flood-fill
    const stack: number[] = [];
    for (let x = 0; x < w; x++) {
      stack.push(x, (h - 1) * w + x);
    }
    for (let y = 1; y < h - 1; y++) {
      stack.push(y * w, y * w + (w - 1));
    }
    while (stack.length) {
      const idx = stack.pop() as number;
      if (visited[idx]) continue;
      visited[idx] = 1;
      const i = idx * 4;
      // 暗色前景保护（绿幕下）：不透 + 不扩散
      if (isDarkFg(i)) {
        px[i + 3] = 255;
        continue;
      }
      const d = dist(i);
      if (d > thrEdge) continue; // 前景边界：不扩散
      if (d <= thr) {
        px[i + 3] = 0;
      } else {
        // 羽化：对齐 Rust cutout.rs 的 smoothstep（t*t*(3-2t)）——越靠近背景越透明、越靠近前景越不透明；
        // 旧实现是 1-t 的线性反相（越靠近背景反而越不透明），过渡带会出现怪异半透明边
        const t = (d - thr) / (thrEdge - thr);
        const s = t * t * (3 - 2 * t);
        px[i + 3] = Math.round(px[i + 3] * s);
      }
      const x = idx % w;
      const y = (idx / w) | 0;
      if (x > 0) stack.push(idx - 1);
      if (x < w - 1) stack.push(idx + 1);
      if (y > 0) stack.push(idx - w);
      if (y < h - 1) stack.push(idx + w);
    }
    // 去绿边/绿晕：对齐 Rust cutout.rs 的 despill/apply_despill/dilate——
    // 初始 fringe＝半透明像素＋4 邻域含高透明像素的不透明边界像素，随后按绿幕强度做 2~3 轮
    // 8 邻域膨胀＋去绿，把「不透明但与高透明相邻的绿晕发丝」也处理掉；旧实现只处理 a<250 且只跑一轮，
    // 不透明边缘的绿边/绿晕会残留。
    const pixelCount = w * h;
    const spillTh = green ? 2 : 6;
    const fringeStrength = green ? 0.95 : 0.85;
    const maxPasses = green ? 3 : 2;
    let fringe = new Uint8Array(pixelCount);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        if (px[idx * 4 + 3] < 250) {
          fringe[idx] = 1;
        } else if (
          px[(idx - 1) * 4 + 3] < 128 ||
          px[(idx + 1) * 4 + 3] < 128 ||
          px[(idx - w) * 4 + 3] < 128 ||
          px[(idx + w) * 4 + 3] < 128
        ) {
          fringe[idx] = 1;
        }
      }
    }
    const applyDespill = (): void => {
      for (let idx = 0; idx < pixelCount; idx++) {
        if (!fringe[idx]) continue;
        const i = idx * 4;
        const r = px[i];
        const g = px[i + 1];
        const b = px[i + 2];
        const spill = g - Math.max(r, b);
        if (spill <= spillTh) continue;
        // 强度按透明度分档（对齐 Rust apply_despill）：不透明用 fringe_strength，
        // 半透明羽化带用 0.85 保留发丝色调，高度半透明用 1.0 几乎彻底去绿
        const a = px[i + 3];
        const strength = a >= 250 ? fringeStrength : a >= 128 ? 0.85 : 1;
        px[i + 1] = Math.round(Math.max(0, g - spill * strength));
      }
    };
    for (let pass = 0; pass < maxPasses; pass++) {
      applyDespill();
      // 8 邻域膨胀 fringe：下一轮把更靠内的不透明绿晕也纳入去绿范围
      const grown = fringe.slice();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if (!fringe[idx]) continue;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const xx = x + dx;
              const yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
              grown[yy * w + xx] = 1;
            }
          }
        }
      }
      fringe = grown;
    }
    applyDespill();
    let removed = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 250) removed++;
    if (removed === 0) return { dataB64, method: "chroma" };
    // 非绿底且透明占比过高 → 疑似把主体误抠掉：保留原图（对齐 Rust skip-overcut），交回前端提示
    if (!green && removed / (w * h) >= 0.6) {
      return { dataB64, method: "skip-overcut" };
    }
    ctx.putImageData(imageData, 0, 0);
    return { dataB64: canvas.toDataURL("image/png").split(",")[1] ?? dataB64, method: "chroma" };
  } catch {
    return { dataB64, method: "chroma" };
  }
}
