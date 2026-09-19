import { dirname } from "./path";
import { log } from "./logger";

/**
 * 浏览器 IndexedDB 虚拟文件系统。
 * Web 版所有文件操作落盘到 IndexedDB（键 = 路径），路径以 / 开头，根目录为 /app。
 */

const DB_NAME = "novelforge-fs";
const STORE = "files";

export interface VfsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

interface VfsFile {
  kind: "file";
  data: ArrayBuffer;
}
interface VfsDir {
  kind: "dir";
}
type VfsNode = VfsFile | VfsDir;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB 打开失败"));
  });
  return dbPromise;
}

async function txGet(key: string): Promise<VfsNode | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as VfsNode | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function txPut(key: string, node: VfsNode): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(node, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function txDelete(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function txKeys(): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error);
  });
}

function normalizeVfsPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return "/" + parts.join("/");
}



/** 确保目录链存在 */
async function ensureDir(path: string): Promise<void> {
  const normalized = normalizeVfsPath(path);
  if (normalized === "/") return;
  const cur = await txGet(normalized);
  if (cur?.kind === "dir") return;
  await txPut(normalized, { kind: "dir" });
  await ensureDir(dirname(normalized));
}

export async function vfsWriteFile(path: string, data: ArrayBuffer): Promise<void> {
  const normalized = normalizeVfsPath(path);
  log.debug("vfs", "写入文件", { path: normalized, size: data.byteLength });
  await ensureDir(dirname(normalized));
  await txPut(normalized, { kind: "file", data });
}

export async function vfsWriteTextFile(path: string, content: string): Promise<void> {
  await vfsWriteFile(path, new TextEncoder().encode(content).buffer);
}

export async function vfsReadFile(path: string): Promise<ArrayBuffer | undefined> {
  const node = await txGet(normalizeVfsPath(path));
  if (!node || node.kind !== "file") {
    log.debug("vfs", "读取文件未命中", { path });
    return undefined;
  }
  return node.data;
}

export async function vfsReadTextFile(path: string): Promise<string | undefined> {
  const buf = await vfsReadFile(path);
  if (!buf) return undefined;
  return new TextDecoder("utf-8").decode(buf);
}

export async function vfsReadFileBase64(path: string): Promise<string | undefined> {
  const buf = await vfsReadFile(path);
  if (!buf) return undefined;
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function vfsWriteFileBase64(path: string, dataB64: string): Promise<void> {
  const bin = atob(dataB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  await vfsWriteFile(path, bytes.buffer);
}

export async function vfsListDir(path: string): Promise<VfsEntry[]> {
  const prefix = normalizeVfsPath(path);
  const keys = await txKeys();
  const entries = new Map<string, VfsEntry>();
  for (const key of keys) {
    if (!key.startsWith(prefix + "/")) continue;
    const rest = key.slice(prefix.length + 1);
    if (!rest) continue;
    const first = rest.split("/")[0];
    if (!first) continue;
    if (entries.has(first)) continue;
    const full = `${prefix}/${first}`;
    const node = await txGet(full);
    const isDir = node?.kind === "dir";
    entries.set(first, {
      name: first,
      path: full,
      isDir,
      size: 0,
    });
  }
  for (const entry of entries.values()) {
    if (!entry.isDir) {
      const node = await txGet(entry.path);
      if (node?.kind === "file") entry.size = node.data.byteLength;
    }
  }
  return [...entries.values()];
}

export async function vfsMkdirAll(path: string): Promise<void> {
  await ensureDir(normalizeVfsPath(path));
}

export async function vfsExists(path: string): Promise<boolean> {
  const node = await txGet(normalizeVfsPath(path));
  return node !== undefined;
}

export async function vfsRemove(path: string): Promise<void> {
  const normalized = normalizeVfsPath(path);
  const keys = await txKeys();
  for (const key of keys) {
    if (key === normalized || key.startsWith(normalized + "/")) {
      await txDelete(key);
    }
  }
}

export async function vfsCopyFile(src: string, dst: string): Promise<void> {
  const data = await vfsReadFile(src);
  if (!data) throw new Error(`复制失败：源文件不存在 ${src}`);
  await vfsWriteFile(dst, data);
}

export async function vfsCopyDirAll(src: string, dst: string): Promise<void> {
  const prefix = normalizeVfsPath(src);
  const keys = await txKeys();
  await vfsMkdirAll(dst);
  for (const key of keys) {
    if (key.startsWith(prefix + "/")) {
      const rel = key.slice(prefix.length);
      const node = await txGet(key);
      if (node?.kind === "file") {
        await vfsWriteFile(normalizeVfsPath(dst + rel), node.data);
      }
    }
  }
}

export async function vfsReplacePath(src: string, dst: string): Promise<void> {
  const source = normalizeVfsPath(src);
  const destination = normalizeVfsPath(dst);
  // B98：旧实现 store.getAll() 会把整个虚拟 FS（含几十 MB 图片）一次性读进内存。
  // 改为只取键、按前缀筛出源路径后逐个 get，内存占用与源目录本身大小成正比。
  const sourceKeys = (await txKeys()).filter((key) => key === source || key.startsWith(source + "/"));
  if (!sourceKeys.length) throw new Error(`替换失败：源路径不存在 ${src}`);
  const entries: { key: string; node: VfsNode }[] = [];
  for (const key of sourceKeys) {
    const node = await txGet(key);
    if (node) entries.push({ key, node });
  }
  // 先清空目标路径，再写入源节点（与旧事务实现的顺序一致）
  const destinationKeys = (await txKeys()).filter((key) => key === destination || key.startsWith(destination + "/"));
  for (const key of destinationKeys) await txDelete(key);
  for (const entry of entries) {
    await txPut(`${destination}${entry.key.slice(source.length)}`, entry.node);
  }
}

/** 递归收集路径下所有文件（用于打包 zip / 预览上传） */
export async function vfsCollectFiles(
  root: string,
  excludePrefixes: string[] = [],
): Promise<{ path: string; data: ArrayBuffer }[]> {
  const prefix = normalizeVfsPath(root);
  const keys = await txKeys();
  const out: { path: string; data: ArrayBuffer }[] = [];
  for (const key of keys) {
    if (!key.startsWith(prefix + "/")) continue;
    const relative = key.slice(prefix.length + 1);
    // exclude 同时支持绝对路径与"相对 root 的目录名"（如 ".novel2vn"）：此前相对名永远匹配不上，
    // Web 打包会把内部缓存/状态一起打进 zip
    if (excludePrefixes.some((ep) => {
      const norm = normalizeVfsPath(ep).replace(/^\/+/, "");
      return relative === norm || relative.startsWith(`${norm}/`) || key.startsWith(normalizeVfsPath(ep));
    })) continue;
    const node = await txGet(key);
    if (node?.kind === "file") {
      out.push({ path: key.slice(prefix.length + 1), data: node.data });
    }
  }
  return out;
}

/** 直接触发浏览器下载（字节已在内存时用，避免再走一次虚拟文件系统读写） */
export function vfsDownloadBytes(data: Uint8Array, downloadName: string, mime = "application/octet-stream"): void {
  const blob = new Blob([data as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = downloadName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 从 IndexedDB 读取文件并触发浏览器下载（zip 等） */
export async function vfsDownloadFile(path: string, downloadName: string): Promise<void> {
  const buf = await vfsReadFile(path);
  if (!buf) throw new Error(`文件不存在：${path}`);
  vfsDownloadBytes(new Uint8Array(buf), downloadName);
}

