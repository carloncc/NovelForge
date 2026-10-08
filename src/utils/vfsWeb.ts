import { dirname } from "./path";
import { log } from "./logger";

/**
 * 浏览器 IndexedDB 虚拟文件系统。
 * Web 版所有文件操作落盘到 IndexedDB（键 = 路径），路径以 / 开头，根目录为 /app。
 */

const DB_NAME = "novelforge-fs";
const STORE = "files";

interface VfsEntry {
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
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB 打开失败"));
  }).catch((err: unknown) => {
    // 失败的 Promise 不能留在缓存里：旧实现把它永久挂在 dbPromise 上，此后每一次 VFS 调用
    // 都直接复用同一个失败结果——用户即便在浏览器里腾出配额、修好 IndexedDB，也必须重启
    // 整个应用（Web 构建没有别的恢复入口）。失败即清空，下一次调用重新尝试打开。
    dbPromise = null;
    throw err;
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

/**
 * #1505：写事务必须同时挂 abort 与 error。
 *
 * 旧实现只挂了 `onerror`。IndexedDB 事务在**没有 error 事件**的情况下也会中止——
 * 配额耗尽时提交阶段直接 abort、或外部调用 `tx.abort()`——此时只触发 `abort`，
 * `onerror` 不触发，于是这个 Promise **既不 resolve 也不 reject**：
 * 调用方的 `await` 永久挂起（导入页的 `importing` 标志永不复位，界面看起来假死）。
 * `txGetMany` 早已挂了 onabort，这里补齐写路径。
 */
export function watchTx(tx: IDBTransaction, resolve: () => void, reject: (reason?: unknown) => void): void {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 事务失败"));
  tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 事务中止（可能是存储空间不足）"));
}

async function txPut(key: string, node: VfsNode): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    watchTx(tx, resolve, reject);
    tx.objectStore(STORE).put(node, key);
  });
}

async function txDelete(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    watchTx(tx, resolve, reject);
    tx.objectStore(STORE).delete(key);
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

/** 一次事务读取多个 key（#1144）：逐 key txGet 在大项目里是 N 次事务往返，这里是 1 次。
 *  请求必须在事务内同步全部发出（IndexedDB 事务在事件循环让出且无待处理请求时自动提交）。 */
async function txGetMany(keys: string[]): Promise<Map<string, VfsNode | undefined>> {
  if (!keys.length) return new Map();
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const out = new Map<string, VfsNode | undefined>();
    for (const key of keys) {
      const req = store.get(key);
      req.onsuccess = () => out.set(key, req.result as VfsNode | undefined);
      req.onerror = () => reject(req.error);
    }
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 事务中止"));
  });
}

/** 批量读取文件（一次事务一批；不存在的 path 直接跳过），返回顺序与入参一致 */

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

/** 网页版小说导入的编码嗅探（#1117）：File.text() 强制按 UTF-8 解码，
 *  GBK/GB18030/BIG5 小说会整篇乱码（或 U+FFFD）。纯函数，不碰 IndexedDB，可单测。
 *  策略：1) UTF-8 严格解码成功 → UTF-8；
 *  2) 否则按 GBK / BIG5 各解一次，选“替换符最少、CJK 最多”者（GBK 优先：中文网文以 GB 系最常见）；
 *  3) 候选标签不受支持时跳过；都失败则回退 UTF-8 宽容解码。
 *  局限：短文本下 GBK 与 BIG5 字节集高度重叠，可能互相干净解码成对方错字（此时按 GBK 优先）；
 *  桌面版可用 Rust chardetng 精确识别。 */
interface DecodedNovel {
  text: string;
  encoding: string;
}

export function decodeNovelBytes(input: ArrayBuffer | Uint8Array): DecodedNovel {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.length) return { text: "", encoding: "UTF-8" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
  } catch {
    /* 非法 UTF-8，走候选编码 */
  }
  const cjkCount = (s: string): number => (s.match(/[\u4E00-\u9FFF]/g) || []).length;
  const fffdCount = (s: string): number => (s.match(/\uFFFD/g) || []).length;
  const candidates: { label: string; encoding: string }[] = [
    { label: "gbk", encoding: "GBK" },
    { label: "big5", encoding: "BIG5" },
  ];
  let best: DecodedNovel | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    let text: string;
    try {
      text = new TextDecoder(c.label).decode(bytes);
    } catch {
      continue;
    }
    const score = fffdCount(text) * 4096 - cjkCount(text);
    if (score < bestScore) {
      bestScore = score;
      best = { text, encoding: c.encoding };
    }
  }
  if (best) {
    if (best.text.charCodeAt(0) === 0xfeff) best = { text: best.text.slice(1), encoding: best.encoding };
    return best;
  }
  return { text: new TextDecoder("utf-8").decode(bytes), encoding: "UTF-8" };
}

/** 网页版多文件导入同名去重（#1138）：同一目录下重名追加 _2/_3…（`1.txt`→`1_2.txt`）。
 *  纯函数：used 为已占路径集合（调用方预填本批已用 + VFS 已有），返回唯一路径并占位。 */
export function uniqueImportPath(used: Set<string>, dir: string, fileName: string): string {
  const clean = fileName.split(/[\\/]/).pop() || "novel.txt";
  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  const prefix = dir.replace(/\/+$/, "");
  let candidate = `${prefix}/${clean}`;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${prefix}/${stem}_${n}${ext}`;
    n++;
  }
  used.add(candidate);
  return candidate;
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
  const childPaths: string[] = [];
  for (const key of keys) {
    if (!key.startsWith(prefix + "/")) continue;
    const rest = key.slice(prefix.length + 1);
    if (!rest) continue;
    const first = rest.split("/")[0];
    if (!first) continue;
    if (entries.has(first)) continue;
    const full = `${prefix}/${first}`;
    entries.set(first, {
      name: first,
      path: full,
      isDir: false,
      size: 0,
    });
    childPaths.push(full);
  }
  // 一次事务取回所有直接子项节点（旧实现每项一次事务，大目录时明显拖慢）
  const nodes = await txGetMany(childPaths);
  for (const entry of entries.values()) {
    const node = nodes.get(entry.path);
    if (node?.kind === "dir") entry.isDir = true;
    else if (node?.kind === "file") entry.size = node.data.byteLength;
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
  const destinationKeys = (await txKeys()).filter((key) => key === destination || key.startsWith(destination + "/"));
  // #1490 契约：project_state.json 的原子写依赖 replace_path —— 写 .tmp 再整体替换，
  // 替换中途失败必须保留旧状态。Tauri 侧 replace_path 自带备份+回滚；Web 侧此前把
  // 「逐个 delete + 逐个 put」拆成 N+M 个独立事务，一旦中途撞上 IndexedDB 配额
  // （QuotaExceededError），删除已提交而 put 失败，旧状态被永久抹掉、只剩半截 .tmp。
  // IndexedDB 事务本身即原子：把删除与写入放进同一个 readwrite 事务，任一步失败整体 abort，
  // 磁盘状态回到替换前，与 Tauri 侧的回滚语义对齐。
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    watchTx(tx, resolve, reject);
    const store = tx.objectStore(STORE);
    for (const key of destinationKeys) store.delete(key);
    for (const entry of entries) {
      store.put(entry.node, `${destination}${entry.key.slice(source.length)}`);
    }
    // 真正的「移动」必须删掉源键：Tauri 侧 replace_path 走 fs::rename，源路径随之消失；
    // Web 侧此前只复制不删，于是 voice.ts 的「把孤儿付费音频移进 .novel2vn/trash」
    // 在 Web 上等于没删（purged 计数虚高、IndexedDB 只增不减），project_state.json 等
    // 原子写的 .tmp 中间键也会永久残留。源键若同时落在目标前缀内（源是目标的祖先/自身）
    // 不能删，否则会把刚 put 进去的目标一起删掉。
    for (const key of sourceKeys) {
      if (key === destination || key.startsWith(destination + "/")) continue;
      store.delete(key);
    }
  });
}

/** 筛选根目录下的文件 key（1 次键事务 + 内存过滤，不做任何值读取） */
/**
 * 相对路径是否可以进入发布包（#1522）。
 *
 * 口径来自预览服务器的 is_preview_blocked：那里把「任一路径组件以 . 开头」当作隐私、不对外提供，
 * 打包器却只排除调用方显式列出的前缀，于是 .git / .env / .npmrc / .idea 会跟着发布包发出去——
 * 项目目录由用户自选，挑在仓库里就会连整个 .git 一起吞进去。两侧对齐后不存在这个缺口。
 *
 * 游戏本体不依赖任何点文件（预览服务器本来就拒绝它们，游戏照样能跑），因此这条规则
 * 不会让正常素材被误伤。
 */
export function isPublishableRelativePath(relative: string): boolean {
  // #1536：原先只按 "/" 切分，Rust 侧 is_preview_blocked 的 Path::components() 在 Windows 上
  // 同时按 / 与反斜杠切分——于是 "a\.env" 在 Rust 被拦、在 Web 打包器却放行（更宽松 = 安全方向失守）。
  // 真实 key 经 normalizeVfsPath 归一化后不会带反斜杠，所以这是潜在而非现网缺口；
  // 但既然差分测试能把它逼出来，就把切分口径对齐，别留给将来。
  return !relative.split(/[\\/]/).some((seg) => seg.startsWith("."));
}

async function collectFileKeys(root: string, excludePrefixes: string[] = []): Promise<{ prefix: string; keys: string[] }> {
  const prefix = normalizeVfsPath(root);
  const keys = (await txKeys()).filter((key) => {
    if (!key.startsWith(prefix + "/")) return false;
    const relative = key.slice(prefix.length + 1);
    // #1522：点文件/点目录一律不进包。与 Rust 侧 write_zip_contents、预览服务器的
    // is_preview_blocked 同一口径：任一路径组件以 . 开头即不进包。
    if (!isPublishableRelativePath(relative)) return false;
    // exclude 同时支持绝对路径与"相对 root 的目录名"（如 ".novel2vn"）：此前相对名永远匹配不上，
    // Web 打包会把内部缓存/状态一起打进 zip
    return !excludePrefixes.some((ep) => {
      const norm = normalizeVfsPath(ep).replace(/^\/+/, "");
      return relative === norm || relative.startsWith(`${norm}/`) || key.startsWith(normalizeVfsPath(ep));
    });
  });
  return { prefix, keys };
}

/** 一次键事务列出根目录下所有文件 key（打包/预览的流式收集入口，避免把值与键一起驻留） */

/** 递归收集路径下所有文件（用于打包 zip / 预览上传）。
 *  #1144：值读取改为分批 txGetMany（每批一次事务），不再逐 key 单事务往返。 */
export async function vfsCollectFiles(
  root: string,
  excludePrefixes: string[] = [],
  batchSize = 64,
): Promise<{ path: string; data: ArrayBuffer }[]> {
  const { prefix, keys } = await collectFileKeys(root, excludePrefixes);
  const out: { path: string; data: ArrayBuffer }[] = [];
  await readFileKeysBatched(prefix, keys, batchSize, (batch) => {
    out.push(...batch);
  });
  return out;
}

/** 分块读取进度：total 为候选 key 数（含目录项，略微高估），done 为已读到的文件数 */
interface VfsBatchProgress {
  done: number;
  total: number;
}

/** 分块读取给定 key：每批 txGetMany 后交给 onBatch（读完即释放，供流式打包逐文件喂 Worker） */
async function readFileKeysBatched(
  prefix: string,
  keys: string[],
  batchSize: number,
  onBatch: (files: { path: string; data: ArrayBuffer }[], progress: VfsBatchProgress) => void | Promise<void>,
): Promise<number> {
  let count = 0;
  for (let i = 0; i < keys.length; i += batchSize) {
    const batchKeys = keys.slice(i, i + batchSize);
    const nodes = await txGetMany(batchKeys);
    const files: { path: string; data: ArrayBuffer }[] = [];
    for (const key of batchKeys) {
      const node = nodes.get(key);
      if (node?.kind === "file") files.push({ path: key.slice(prefix.length + 1), data: node.data });
    }
    count += files.length;
    await onBatch(files, { done: count, total: keys.length });
  }
  return count;
}

/** 分块收集根目录下所有文件（#1143 流式打包入口）：
 *  一次键事务 + 每批一次读取事务，每个文件只在 onBatch 期间驻留，避免「全部文件 + zip」同时占内存。 */
export async function vfsCollectFilesBatched(
  root: string,
  excludePrefixes: string[],
  onBatch: (files: { path: string; data: ArrayBuffer }[], progress: VfsBatchProgress) => void | Promise<void>,
  batchSize = 16,
): Promise<number> {
  const { prefix, keys } = await collectFileKeys(root, excludePrefixes);
  return readFileKeysBatched(prefix, keys, Math.max(1, batchSize), onBatch);
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

/** 分块字节直接下载（#1143）：Blob 接受分块数组，无需再拼成一份连续 Uint8Array（省一次整包拷贝） */
export function vfsDownloadChunks(chunks: Uint8Array[], downloadName: string, mime = "application/octet-stream"): void {
  const parts = chunks.map((c) => (c.byteOffset === 0 && c.byteLength === c.buffer.byteLength ? c : c.slice()));
  const blob = new Blob(parts as unknown as BlobPart[], { type: mime });
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

