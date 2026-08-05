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
  } catch {
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
  await ensureTemplateLocal(TEMPLATE_ROOT);
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

/** 色度键抠图（对齐 Rust 实现）：四角采样背景色 → flood-fill 连通约束 → 边缘羽化。
 *  背景像素置透明，主体边界像素半透明渐变（抗锯齿），主体内部同色区域不受影响。 */
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

    // 背景参考色：取四角区域平均（忽略透明像素）
    const corners = [
      [0, 0],
      [w - 1, 0],
      [0, h - 1],
      [w - 1, h - 1],
    ];
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let n = 0;
    for (const [x, y] of corners) {
      for (let dx = 0; dx < 4; dx++) {
        for (let dy = 0; dy < 4; dy++) {
          const i = ((y + dy) * w + (x + dx)) * 4;
          if (px[i + 3] > 240) {
            rSum += px[i];
            gSum += px[i + 1];
            bSum += px[i + 2];
            n++;
          }
        }
      }
    }
    if (n === 0) return dataB64;
    const bgR = rSum / n;
    const bgG = gSum / n;
    const bgB = bSum / n;

    const thr = threshold * 3; // 完全透明容差（曼哈顿距离）
    const thrEdge = threshold * 4.5; // 羽化区间上界

    // 四角种子 flood-fill
    const stack: number[] = [];
    for (const [x, y] of corners) {
      const i = (y * w + x) * 4;
      const dist = Math.abs(px[i] - bgR) + Math.abs(px[i + 1] - bgG) + Math.abs(px[i + 2] - bgB);
      if (dist <= thrEdge) stack.push(y * w + x);
    }
    while (stack.length) {
      const idx = stack.pop() as number;
      if (visited[idx]) continue;
      visited[idx] = 1;
      const i = idx * 4;
      const dist = Math.abs(px[i] - bgR) + Math.abs(px[i + 1] - bgG) + Math.abs(px[i + 2] - bgB);
      if (dist > thrEdge) continue;
      if (dist <= thr) {
        px[i + 3] = 0;
      } else {
        // 羽化：边缘半透明渐变（抗锯齿）
        const t = 1 - (dist - thr) / (thrEdge - thr);
        px[i + 3] = Math.round(px[i + 3] * (0.15 + 0.85 * t));
      }
      const x = idx % w;
      const y = (idx / w) | 0;
      if (x > 0) stack.push(idx - 1);
      if (x < w - 1) stack.push(idx + 1);
      if (y > 0) stack.push(idx - w);
      if (y < h - 1) stack.push(idx + w);
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
