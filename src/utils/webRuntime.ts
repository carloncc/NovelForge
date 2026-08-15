/**
 * 浏览器（非 Tauri）运行时实现。
 * - HTTP：经同源代理 /__novelforge/proxy（dev/preview server 提供，规避 CORS）
 * - 文件：IndexedDB 虚拟 FS；/app/template 首次访问从 dev server 同步缓存
 * - 预览：前端 zip 打包 → 上传 /__novelforge/preview → 解压静态服务
 * - 抠图：canvas 四角 flood-fill 去背景
 */
import { zipSync } from "fflate";
import type { FsEntry, HttpResult } from "./tauri";
import * as vfs from "./vfsWeb";
import { log, truncate } from "./logger";
import { errMsg } from "./errors";

export function isWeb(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

const PROXY_URL = "/__novelforge/proxy";
const TEMPLATE_URL = "/__novelforge/template";
const PREVIEW_URL = "/__novelforge/preview";
const TEMPLATE_ROOT = "/app/template";

function b64encode(data: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(data).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
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
  timeoutSecs?: number;
}): Promise<HttpResult> {
  // 非 http(s) 的目标（如 file:）无法代理，直接直连尝试
  if (!/^https?:\/\//i.test(args.url)) {
    return directFetch(args);
  }
  try {
    const resp = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: args.method,
        url: args.url,
        headers: args.headers ?? {},
        body: args.body ?? "",
        timeoutSecs: args.timeoutSecs ?? 120,
      }),
    });
    if (!resp.ok) throw new Error(`代理不可用 ${resp.status}`);
    const json = (await resp.json()) as { status: number; contentType: string; bodyBase64: string };
    return { status: json.status, contentType: json.contentType, bodyBase64: json.bodyBase64 };
  } catch (e) {
    log.warn("webRuntime", "同源代理失败，尝试直连", { url: args.url, error: errMsg(e) });
    return directFetch(args);
  }
}

async function directFetch(args: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutSecs?: number;
}): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (args.timeoutSecs ?? 120) * 1000);
  try {
    const resp = await fetch(args.url, {
      method: args.method,
      headers: args.headers,
      body: args.body,
      signal: controller.signal,
    });
    const buf = new Uint8Array(await resp.arrayBuffer());
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
  const resp = await fetch(`${TEMPLATE_URL}?path=${encodeURIComponent(rel)}`, { method: "GET" });
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
  if (text === undefined) throw new Error(`文件不存在：${path}`);
  return { text, encoding: "UTF-8" };
}

export async function webReadFileBase64(path: string): Promise<string> {
  if (path.startsWith(TEMPLATE_ROOT + "/")) await ensureTemplateLocal(path);
  const b64 = await vfs.vfsReadFileBase64(path);
  if (b64 === undefined) throw new Error(`文件不存在：${path}`);
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
    const node = await fetchTemplateNode(path.slice(TEMPLATE_ROOT.length + 1));
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

export async function webReadConfig(): Promise<string> {
  return localStorage.getItem(CONFIG_KEY) ?? "{}";
}

export async function webWriteConfig(content: string): Promise<void> {
  localStorage.setItem(CONFIG_KEY, content);
}

/* ============ 预览（zip 上传 → dev server 解压静态服务） ============ */

export async function webStartPreviewServer(root: string): Promise<{ url: string; port: number }> {
  log.info("webRuntime", "web 预览启动", { root });
  await ensureTemplateTree();
  const files = await vfs.vfsCollectFiles(root, [`${root}/.novel2vn`]);
  if (!files.length) throw new Error(`预览失败：目录为空（${root}）`);
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.path] = new Uint8Array(f.data);
  const zipData = zipSync(entries);
  const name = root.split("/").filter(Boolean).pop() || "game";
  const resp = await fetch(PREVIEW_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, zip: b64encode(zipData) }),
  });
  if (!resp.ok) throw new Error(`预览上传失败 ${resp.status}`);
  const json = (await resp.json()) as { url: string };
  log.info("webRuntime", "web 预览就绪", { url: json.url, files: files.length });
  return { url: json.url, port: 0 };
}

/* ============ 打包 zip（导出页面） ============ */

export async function webBuildZip(
  sourceDir: string,
  zipPath: string,
  exclude: string[],
): Promise<{ fileCount: number; sizeBytes: number }> {
  const files = await vfs.vfsCollectFiles(sourceDir, exclude);
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) {
    entries[f.path] = new Uint8Array(f.data);
  }
  const zipData = zipSync(entries);
  await vfs.vfsWriteFile(zipPath, zipData as unknown as ArrayBuffer);
  return { fileCount: files.length, sizeBytes: zipData.byteLength };
}

/* ============ 抠图（canvas 四角 flood-fill 去背景） ============ */

async function loadImage(dataB64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片解码失败"));
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
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** 色度键抠图（对齐 Rust 实现）：边缘采样背景色 → 从四边 flood-fill 连通约束 → 边缘羽化。
 *  只移除与边缘相连的背景区域，主体内部与背景相近的孤立像素（如脸部高光）不会被误删。
 *  绿幕下启用色度加权距离（降 G 权重）+ 暗色前景保护（max(rgb)<60 当前景边界），
 *  对齐 Rust cutout.rs 行为，避免「绿底把黑色抠成灰色半透明」。 */
export async function webCutoutImage(dataB64: string, threshold = 40): Promise<string> {
  try {
    const img = await loadImage(dataB64);
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataB64;
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
    if (rs.length < 8) return dataB64;
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

    // 绿幕下用更大容差与色度加权距离（降 G 权重）
    const thr = green ? Math.max(threshold, 80) : threshold;
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

    const DARK_FG_THRESH = 60;
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
        // 羽化：边缘半透明渐变（抗锯齿）
        const t = 1 - (d - thr) / (thrEdge - thr);
        px[i + 3] = Math.round(px[i + 3] * (0.15 + 0.85 * t));
      }
      const x = idx % w;
      const y = (idx / w) | 0;
      if (x > 0) stack.push(idx - 1);
      if (x < w - 1) stack.push(idx + 1);
      if (y > 0) stack.push(idx - w);
      if (y < h - 1) stack.push(idx + w);
    }
    // 去绿边/绿晕：对边缘与半透明像素，绿色明显高于红/蓝时压制绿色（与 Rust 版一致）
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      const a = px[i + 3];
      const maxRB = Math.max(r, b);
      const spill = g - maxRB;
      if (spill > 6 && a < 250) {
        const strength = a < 200 ? 1 : 0.85;
        px[i + 1] = Math.round(Math.max(0, g - spill * strength));
      }
    }
    let removed = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 250) removed++;
    if (removed === 0) return dataB64;
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1] ?? dataB64;
  } catch {
    return dataB64;
  }
}
