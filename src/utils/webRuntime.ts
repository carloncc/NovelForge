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
import { b64decode as strictB64decode, b64encode } from "./base64";
import { t } from "../i18n";

const PROXY_URL = "/__novelforge/proxy";
const TEMPLATE_URL = "/__novelforge/template";
const PREVIEW_URL = "/__novelforge/preview";
const SESSION_URL = "/__novelforge/session";
const MODEL_URL = "/__novelforge/model";
const TEMPLATE_ROOT = "/app/template";
const WEB_RESPONSE_LIMIT = 64 * 1024 * 1024;
/**
 * #1523：与 Rust cutout.rs 的 MAX_INPUT_B64_BYTES / MAX_INPUT_PIXELS 同口径。
 * Web 版此前完全没有这道闸门，而 #1471 已经在桌面端把它抽成 decode_guarded 单一入口——
 * 姊妹实现漏掉正是那次要防的事。
 */
export const CUTOUT_MAX_INPUT_B64_BYTES = 32 * 1024 * 1024;
export const CUTOUT_MAX_INPUT_PIXELS = 4096 * 4096;
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
 * 导出以便测试按类型/状态码断言（文案随界面语言变化，不参与断言）。
 */
export class ProxyHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProxyHttpError";
  }
}

// #1532：原本是 base64.ts 的一份手抄副本，且对非法输入的行为与 tauri 侧不一致。
// 统一走 base64.ts 的严格解码，避免三份实现各行其是。
const b64decode = strictB64decode;

/* ============ HTTP（同源代理，规避厂商 CORS） ============ */

export async function webHttp(args: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  timeoutSecs?: number;
  /** #784：外部中止信号（管线「停止」时中断在途 fetch） */
  signal?: AbortSignal;
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
      signal: args.signal,
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
    // 代理路径也要有体积上限：直连走 readLimitedWebResponse（64MB），
    // 桌面端有 ensure_readable_size / MAX_INPUT_B64_BYTES，而代理分支此前直接
    // resp.json() 把整包（还含 base64 约 1.33× 膨胀）一次性读进内存。
    // 厂商返回失控大包（或永不结束的流）时，Web 版会一路撑到标签页 OOM。
    // 代理包内是 base64，故按 4/3 放宽到字节阈值再判。
    const declared = Number(resp.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > WEB_RESPONSE_LIMIT * 1.4) {
      throw new ProxyHttpError(t("代理响应体过大（超过 {mb} MB 上限）", { mb: Math.round(WEB_RESPONSE_LIMIT / 1024 / 1024) }), resp.status);
    }
    // B97 续：拿到响应头后，请求已确定送达代理/厂商。此后任何失败（含响应体被截断导致
    // 的 JSON 解析错误）都绝不能回退 directFetch —— 那会把同一个付费 POST 再发一次，
    // 厂商照常计费两次而第一次的结果被丢弃。解析失败按「已送达」处理，直接抛出。
    let json: { status: number; contentType: string; bodyBase64: string };
    try {
      json = (await resp.json()) as { status: number; contentType: string; bodyBase64: string };
    } catch (e) {
      throw new ProxyHttpError(
        t("代理响应体解析失败（请求已发出，不会自动重发以免重复计费）：{detail}", {
          detail: errMsg(e).slice(0, 200),
        }),
        resp.status,
      );
    }
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
  signal?: AbortSignal;
}): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (args.timeoutSecs ?? 120) * 1000);
  // 外部中止与超时共用一个 controller：任一触发即中断 fetch
  const onAbort = (): void => controller.abort();
  if (args.signal?.aborted) controller.abort();
  args.signal?.addEventListener("abort", onAbort, { once: true });
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
    args.signal?.removeEventListener("abort", onAbort);
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
/** #1514：fflate 回退路径同口径——os=3(Unix) + attrs=权限<<16，否则整包压缩时又丢执行位 */
const ZIP_EXEC_RE = /\.(command|sh)$/i;

/** #1526：zip 格式里「未压缩长度/压缩长度」各占 4 字节，「条目数」占 2 字节。
 *  超过即回绕，且没有报错——产出的包看起来正常，解压时才发现坏。
 */
export const ZIP_MAX_ENTRY_BYTES = 0xffffffff;
export const ZIP_MAX_ENTRY_COUNT = 0xffff;
/** #1541：文件名字段在 zip 里是 u16，fflate 在超过 65535 **UTF-8 字节**时抛 `filename too long`。
 * 此前 zipEntriesOverflowReason 只查条目数与单文件字节数，漏了名字长度这一维，于是超长路径
 * 会一路走到 fflate 才炸，用户看到的是英文原始报错、而不是本函数统一给出的中文原因。
 * 中文路径尤其容易踩到：三个汉字就是 9 字节。 */
export const ZIP_MAX_NAME_BYTES = 0xffff;

/** #1526：fflate 的 zipSync 只会写 32 位长度（其 wzh 里 wbytes(d, b+8, f.size)），
 *  且**不会**自动补 ZIP64 扩展字段，溢出时也不抛错。
 *
 *  桌面端 Rust 打包早已开 .large_file(true)（commands.rs #1440：项目内单文件 ≥4GiB，
 *  例如导入的长视频），而 Web 端走的是 fflate——同一个项目在桌面端导出正常，
 *  在 Web 端会静默产出**损坏**的 zip，用户拿到手才发现打不开。
 *
 *  与其让人拿到一个坏包，不如在唯一的打包入口明确拒绝并说清原因。
 *  注意条目数也要查：wzh 里条目数写的是 u16，超过 65535 同样回绕。
 */
export function zipEntriesOverflowReason(sizes: Record<string, number>): string | null {
  const names = Object.keys(sizes);
  // #1541：名字长度（UTF-8 字节数，与 zip 的 u16 字段同一口径）
  for (const name of names) {
    const bytes = new TextEncoder().encode(name).length;
    if (bytes > ZIP_MAX_NAME_BYTES) {
      return t("文件路径「{name}」有 {bytes} 字节，超过 zip 格式 65535 字节上限（Web 端打包器不支持 ZIP64 的扩展字段）", {
        name: name.slice(0, 80),
        bytes,
      });
    }
  }
  if (names.length > ZIP_MAX_ENTRY_COUNT) {
    return t("打包条目数 {count} 超过 zip 格式 {max} 上限", { count: names.length, max: ZIP_MAX_ENTRY_COUNT });
  }
  for (const name of names) {
    const bytes = sizes[name];
    if (bytes > ZIP_MAX_ENTRY_BYTES) {
      return t("文件「{name}」有 {mb} MB，超过 zip 格式 4GB 上限；Web 端打包器不支持 ZIP64", {
        name,
        mb: Math.floor(bytes / 1048576),
      });
    }
  }
  return null;
}

/** 流式打包时从 VFS 分批读取的批大小：越小内存峰值越低，越大事务开销越小 */
const ZIP_READ_BATCH = 8;

/** 在专用 Worker 中压缩（浏览器）；Node（单测）无 Worker 时回退同步压缩 */
async function zipEntries(entries: Record<string, [Uint8Array, { level: 0 | 6 }]>): Promise<Uint8Array> {
  // #1526：先查能否用 zip 的 32 位字段表示（Worker 与同步回退共用同一个 zipSync）
  const reason = zipEntriesOverflowReason(
    Object.fromEntries(Object.entries(entries).map(([name, data]) => [name, data[0].byteLength])),
  );
  if (reason) return Promise.reject(new Error(reason));
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

/** 无法创建流式 zip Worker（旧内核/CSP/非浏览器环境）时抛出：调用方回退到整包压缩 */
class ZipStreamUnavailable extends Error {}

/**
 * 流式 ZIP Worker 主体（#1143）：以函数源码注入 Blob Worker，无打包器依赖。
 * 逐文件压缩：媒体/字体直存、文本用 CompressionStream('deflate-raw')（不支持时退化为直存）；
 * 压缩结果分块回传主线程（Transferable），Worker 内不保留整包字节，
 * 内存峰值 ≈ 单个文件 + 已压缩输出（旧实现是「全部原始字节 + 结构化克隆 + 压缩结果」三份叠加）。
 * 注意：本函数必须自包含（不引用模块作用域的任何变量），因为它以 toString() 注入 Worker。
 * 导出仅供单测用假 scope 驱动（生产路径只通过 toString() 注入）。
 */
export function zipStreamScope(scope: {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage: (message: unknown, transfer?: unknown[]) => void;
}): void {
  const encoder = new TextEncoder();
  const u16 = (buf: Uint8Array, off: number, v: number): void => {
    buf[off] = v & 0xff;
    buf[off + 1] = (v >>> 8) & 0xff;
  };
  const u32 = (buf: Uint8Array, off: number, v: number): void => {
    buf[off] = v & 0xff;
    buf[off + 1] = (v >>> 8) & 0xff;
    buf[off + 2] = (v >>> 16) & 0xff;
    buf[off + 3] = (v >>> 24) & 0xff;
  };
  let crcTable: Uint32Array | null = null;
  const crc32 = (bytes: Uint8Array): number => {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  /** 分块回传；只转移独占 buffer（压缩流分块可能是大 buffer 的视图，需先拷贝） */
  const emit = (bytes: Uint8Array): void => {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
      scope.postMessage({ type: "chunk", data: bytes }, [bytes.buffer]);
    } else {
      const copy = bytes.slice();
      scope.postMessage({ type: "chunk", data: copy }, [copy.buffer]);
    }
  };
  interface Entry {
    name: Uint8Array;
    method: number;
    crc: number;
    comp: number;
    uncomp: number;
    offset: number;
    executable: boolean;
  }
  /** #1514：随包 .command/.sh 必须带执行位，否则 macOS 解压后双击无反应。
   *  ZIP 的 unix 权限放在 central directory 的 external file attributes 高 16 位，
   *  且必须把「version made by」高字节标成 Unix(3)，解压工具（macOS 归档实用工具 / unzip）才认。
   *  非脚本条目保持原样（host=MS-DOS、attrs=0），避免改变既有解压行为。 */
  const isExecutableEntry = (path: string): boolean => {
    const lower = path.toLowerCase();
    return lower.endsWith(".command") || lower.endsWith(".sh");
  };
  const entries: Entry[] = [];
  let offset = 0;
  const MAX32 = 0xffffffff;

  const addFile = async (path: string, data: Uint8Array, store: boolean): Promise<void> => {
    if (entries.length >= 65535) throw new Error("文件数超过 ZIP（非 zip64）上限 65535");
    if (data.byteLength > MAX32) throw new Error(`单个文件超过 ZIP 4GB 上限：${path}`);
    const name = encoder.encode(path);
    if (name.length > 65535) throw new Error(`文件名过长：${path}`);
    const canDeflate = !store && typeof CompressionStream !== "undefined";
    const method = canDeflate ? 8 : 0;
    const crc = crc32(data);
    const localOffset = offset;
    // 本地文件头：bit3 = 数据描述符（压缩后尺寸未知），bit11 = UTF-8 名称
    const header = new Uint8Array(30 + name.length);
    u32(header, 0, 0x04034b50);
    u16(header, 4, 20);
    u16(header, 6, 0x0808);
    u16(header, 8, method);
    u16(header, 10, 0);
    u16(header, 12, 0x0021); // 1980-01-01：0 日期会被部分解压工具判为非法
    u32(header, 14, 0);
    u32(header, 18, 0);
    u32(header, 22, 0);
    u16(header, 26, name.length);
    u16(header, 28, 0);
    header.set(name, 30);
    offset += header.length;
    emit(header);

    let comp = data.byteLength;
    if (method === 8) {
      comp = 0;
      const stream = new CompressionStream("deflate-raw");
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();
      const pump = (async () => {
        await writer.write(data);
        await writer.close();
      })();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        comp += value.byteLength;
        emit(value);
      }
      await pump;
    } else if (data.byteLength > 0) {
      emit(data); // 转移文件字节，Worker 不保留副本
    }
    offset += comp;
    // 数据描述符：签名 + crc + 压缩尺寸 + 原始尺寸
    const dd = new Uint8Array(16);
    u32(dd, 0, 0x08074b50);
    u32(dd, 4, crc);
    u32(dd, 8, comp);
    u32(dd, 12, data.byteLength);
    offset += dd.length;
    emit(dd);
    if (offset > MAX32) throw new Error("项目超过 ZIP（非 zip64）4GB 上限");
    entries.push({ name, method, crc, comp, uncomp: data.byteLength, offset: localOffset, executable: isExecutableEntry(path) });
  };

  const finish = (): void => {
    const cdOffset = offset;
    let cdSize = 0;
    for (const e of entries) {
      const rec = new Uint8Array(46 + e.name.length);
      u32(rec, 0, 0x02014b50);
      // 高字节 = 制作主机 OS（3=Unix）；仅脚本条目标注，权限位才生效
      u16(rec, 4, e.executable ? (3 << 8) | 20 : 20);
      u16(rec, 6, 20);
      u16(rec, 8, 0x0808);
      u16(rec, 10, e.method);
      u16(rec, 12, 0);
      u16(rec, 14, 0x0021);
      u32(rec, 16, e.crc);
      u32(rec, 20, e.comp);
      u32(rec, 24, e.uncomp);
      u16(rec, 28, e.name.length);
      u16(rec, 30, 0);
      u16(rec, 32, 0);
      u16(rec, 34, 0);
      u16(rec, 36, 0);
      // external file attributes：高 16 位即 unix 权限位（#1514）
      u32(rec, 38, e.executable ? 0o755 << 16 : 0);
      u32(rec, 42, e.offset);
      rec.set(e.name, 46);
      emit(rec);
      cdSize += rec.length;
    }
    offset += cdSize;
    const eocd = new Uint8Array(22);
    u32(eocd, 0, 0x06054b50);
    u16(eocd, 4, 0);
    u16(eocd, 6, 0);
    u16(eocd, 8, entries.length);
    u16(eocd, 10, entries.length);
    u32(eocd, 12, cdSize);
    u32(eocd, 16, cdOffset);
    u16(eocd, 20, 0);
    offset += eocd.length;
    emit(eocd);
    scope.postMessage({ type: "done", fileCount: entries.length, sizeBytes: offset });
  };

  let queue: Promise<void> = Promise.resolve();
  scope.onmessage = (ev: { data: unknown }): void => {
    const msg = ev.data as { type?: string; path?: string; store?: boolean; data?: ArrayBuffer };
    queue = queue.then(async () => {
      try {
        if (msg.type === "add" && msg.path && msg.data) {
          await addFile(msg.path, new Uint8Array(msg.data), msg.store === true);
          scope.postMessage({ type: "added", path: msg.path });
        } else if (msg.type === "end") {
          finish();
        }
      } catch (error) {
        scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    });
  };
}

interface ZipStreamResult {
  fileCount: number;
  sizeBytes: number;
  chunks: Uint8Array[];
}

interface ZipStreamClient {
  add(path: string, data: ArrayBuffer, store: boolean): Promise<void>;
  finish(): Promise<ZipStreamResult>;
  dispose(): void;
}

function canStreamZip(): boolean {
  return typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
}

/** 创建流式 zip Worker 客户端（逐文件 add → 回传压缩分块；失败时抛 ZipStreamUnavailable） */
function createZipStreamClient(): ZipStreamClient {
  let url = "";
  let worker: Worker;
  try {
    url = URL.createObjectURL(new Blob([`(${zipStreamScope.toString()})(self);`], { type: "text/javascript" }));
    worker = new Worker(url);
  } catch (error) {
    if (url) URL.revokeObjectURL(url);
    throw new ZipStreamUnavailable(errMsg(error));
  }
  const chunks: Uint8Array[] = [];
  let resolveAdd: (() => void) | null = null;
  let rejectAdd: ((e: Error) => void) | null = null;
  let resolveDone: ((r: ZipStreamResult) => void) | null = null;
  let rejectDone: ((e: Error) => void) | null = null;
  const settleError = (e: Error): void => {
    rejectAdd?.(e);
    rejectDone?.(e);
    resolveAdd = null;
    rejectAdd = null;
    resolveDone = null;
    rejectDone = null;
  };
  worker.onmessage = (ev: MessageEvent<{ type?: string; data?: ArrayBuffer; message?: string; fileCount?: number; sizeBytes?: number }>) => {
    const msg = ev.data ?? {};
    if (msg.type === "chunk" && msg.data) {
      chunks.push(new Uint8Array(msg.data));
      return;
    }
    if (msg.type === "added") {
      const r = resolveAdd;
      resolveAdd = null;
      rejectAdd = null;
      r?.();
      return;
    }
    if (msg.type === "done") {
      const r = resolveDone;
      resolveDone = null;
      rejectDone = null;
      r?.({ fileCount: msg.fileCount ?? 0, sizeBytes: msg.sizeBytes ?? 0, chunks });
      return;
    }
    if (msg.type === "error") settleError(new Error(msg.message || t("zip worker 执行失败")));
  };
  worker.onerror = (e) => settleError(new Error(e.message || t("zip worker 执行失败")));
  return {
    add: (path, data, store) =>
      new Promise<void>((resolve, reject) => {
        resolveAdd = resolve;
        rejectAdd = reject;
        worker.postMessage({ type: "add", path, store, data }, [data]);
      }),
    finish: () =>
      new Promise<ZipStreamResult>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
        worker.postMessage({ type: "end" });
      }),
    dispose: () => {
      worker.terminate();
      if (url) URL.revokeObjectURL(url);
    },
  };
}

/** 一次性事务列出 + 每批一次事务读取 → 逐文件喂给流式 Worker（#1143/#1144） */
async function streamZipFromVfs(
  sourceDir: string,
  exclude: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<ZipStreamResult> {
  const client = createZipStreamClient();
  try {
    await vfs.vfsCollectFilesBatched(
      sourceDir,
      exclude,
      async (files, progress) => {
        for (const f of files) {
          await client.add(f.path, f.data, ZIP_MEDIA_RE.test(f.path));
        }
        onProgress?.(progress.done, progress.total);
      },
      ZIP_READ_BATCH,
    );
    return await client.finish();
  } finally {
    client.dispose();
  }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const c of chunks) size += c.byteLength;
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function webBuildZip(
  sourceDir: string,
  _zipPath: string,
  exclude: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ fileCount: number; sizeBytes: number; data: Uint8Array }> {
  if (canStreamZip()) {
    try {
      const { fileCount, sizeBytes, chunks } = await streamZipFromVfs(sourceDir, exclude, onProgress);
      return { fileCount, sizeBytes, data: concatChunks(chunks) };
    } catch (e) {
      if (!(e instanceof ZipStreamUnavailable)) throw e;
      log.warn("webRuntime", "流式 zip Worker 不可用，回退整包压缩", { error: errMsg(e) });
    }
  }
  const files = await vfs.vfsCollectFiles(sourceDir, exclude);
  const entries: Record<string, [Uint8Array, { level: 0 | 6; os?: number; attrs?: number }]> = {};
  for (const f of files) {
    entries[f.path] = ZIP_EXEC_RE.test(f.path)
      ? [new Uint8Array(f.data), { level: 6, os: 3, attrs: 0o755 << 16 }]
      : [new Uint8Array(f.data), { level: ZIP_MEDIA_RE.test(f.path) ? 0 : 6 }];
  }
  const zipData = await zipEntries(entries);
  return { fileCount: files.length, sizeBytes: zipData.byteLength, data: zipData };
}

/** 网页版导出：压缩后直接触发浏览器下载（应用层调用，字节不经日志包装）。
 *  流式路径把压缩分块直接交给 Blob 下载，不再拼成一份连续 Uint8Array（#1143）。 */
export async function webDownloadZip(
  sourceDir: string,
  exclude: string[],
  downloadName: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ fileCount: number; sizeBytes: number }> {
  if (canStreamZip()) {
    try {
      const { fileCount, sizeBytes, chunks } = await streamZipFromVfs(sourceDir, exclude, onProgress);
      vfs.vfsDownloadChunks(chunks, downloadName, "application/zip");
      return { fileCount, sizeBytes };
    } catch (e) {
      if (!(e instanceof ZipStreamUnavailable)) throw e;
      log.warn("webRuntime", "流式 zip Worker 不可用，回退整包压缩", { error: errMsg(e) });
    }
  }
  const { fileCount, sizeBytes, data } = await webBuildZip(sourceDir, "", exclude, onProgress);
  vfs.vfsDownloadBytes(data, downloadName, "application/zip");
  return { fileCount, sizeBytes };
}

/* ============ 抠图（canvas 四角 flood-fill 去背景） ============ */

/* ============ AI 抠图模型下载（dev/preview server 的 /__novelforge/model 中间件） ============ */

export async function webCutoutModelStatus(modelId: string, _filename: string): Promise<CutoutModelStatus> {
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

export async function webCutoutModelRemove(modelId: string, _filename: string): Promise<void> {
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
  // #1523：解码前的统一输入上限校验（对齐 Rust cutout.rs 的 decode_guarded）——
  // 先限 base64 长度，再限解码后的像素数，两个上限都对应 Rust 侧的同名常量。
  //
  // 为什么必须补：Web 端两个抠图入口此前毫无闸门，一张超大图会依次触发
  // data: URL 解码 → 全尺寸 canvas → getImageData 再拷一份 RGBA → visited 缓冲，
  // 在 4G 目标机上就是标签页 OOM。#1471 在桌面端修掉的正是同一种分配放大，
  // 当时只改了 Rust 侧；把闸门放在唯一的解码入口，姊妹路径不会再各漏一次。
  //
  // 抛出会被两个调用方各自的 catch 接住：webCutoutImage 按 #1309 直接抛出，
  // webHasTransparency 同样抛出，最终都落到「抠图失败保留原图 + 记日志」的显式回退。
  if (dataB64.length > CUTOUT_MAX_INPUT_B64_BYTES) {
    throw new Error(
      t("图片数据过大（{mb} MB），超过 {limit} MB 上限，已拒绝", {
        mb: Math.floor(dataB64.length / 1048576),
        limit: CUTOUT_MAX_INPUT_B64_BYTES / 1048576,
      }),
    );
  }
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(t("图片解码失败")));
    el.src = `data:image/png;base64,${dataB64}`;
  });
  // 在 canvas / getImageData 分配整幅缓冲之前先检查尺寸
  const pixels = img.width * img.height;
  if (pixels > CUTOUT_MAX_INPUT_PIXELS) {
    throw new Error(
      t("图片尺寸过大（{w}×{h}，{mp} 万像素），超过 {limit}×{limit} 上限，已拒绝", {
        w: img.width,
        h: img.height,
        mp: Math.floor(pixels / 10000),
        limit: Math.round(Math.sqrt(CUTOUT_MAX_INPUT_PIXELS)),
      }),
    );
  }
  return img;
}

export async function webHasTransparency(dataB64: string): Promise<boolean> {
  try {
    const img = await loadImage(dataB64);
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    // #1497：取不到 2D 上下文时不能再返回 true。返回 true 的语义是「这张图已经带透明通道」，
    // 调用方（images.ts 的 cutoutFigure）会因此**直接跳过抠图并原样保留绿幕**——
    // 属于静默降级成"绿底立绘"。改为抛出，让调用方的 catch 走"抠图失败保留原图 + 记日志"分支。
    if (!ctx) throw new Error(t("无法创建画布上下文"));
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // 与桌面版（Rust has_transparency）对齐：alpha<16 的像素占比 >5% 才算「已透明」。
    // 旧实现「任一 alpha<250 即已透明」会让 AI 常返回的边缘半透明 PNG 直接跳过抠图、绿幕整片残留。
    let low = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 16) low++;
    }
    return low / Math.max(1, data.length / 4) > 0.05;
  } catch (error) {
    // 解码/画布失败同样抛出（#1497）：与 Rust 侧 has_transparency 的 Ok/Err 语义一致，
    // 由调用方决定降级策略，绝不用"已透明"来假装成功。
    log.warn("webRuntime", "透明通道检测失败，交由调用方降级", { error: String(error).slice(0, 160) });
    throw error;
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
    // #1497 同类：取不到 2D 上下文时返回 {method:"chroma"} 等于宣称「已按绿幕抠好」，
    // 调用方会当成抠图成功直接采用——实际是原样未处理的绿底图。改为抛出，
    // 让调用方的 catch 走「抠图失败保留原图 + 记日志」分支（与 webHasTransparency 同口径）。
    if (!ctx) throw new Error(t("无法创建画布上下文"));
    ctx.drawImage(img, 0, 0);
    const w = canvas.width;
    const h = canvas.height;
    const imageData = ctx.getImageData(0, 0, w, h);
    const px = imageData.data;
    const visited = new Uint8Array(w * h);

    // 背景参考色：边缘一圈采样，取各通道中位数（抗前景人物干扰）
    // #1548：ring 与「亮像素优先」都对齐 Rust sample_bg_color。此前 Web 端 ring=6 且直接
    // 对**全量**边缘样本取中位数，而 Rust 会先把 max channel < 60 的暗像素剔除（暗像素大概率
    // 是前景黑发/黑衣，混进来会把背景色拉黑），亮样本够多时优先用亮样本。
    // 结果是同一张素材在桌面端与网页端算出不同的背景参考色 → 色度键阈值不同 → 抠出的图不同，
    // 而本文件开头的注释恰恰写着「对齐 Rust 实现」。Rust 侧 green_bg_with_dark_edge_keeps_dark_figure
    // 与 cutout_green_bg_preserves_black_figure 就是为这个场景加的回归。
    const ring = 8;
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    const rsBright: number[] = [];
    const gsBright: number[] = [];
    const bsBright: number[] = [];
    const pushPx = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      if (px[i + 3] > 240) {
        rs.push(px[i]);
        gs.push(px[i + 1]);
        bs.push(px[i + 2]);
        if (Math.max(px[i], px[i + 1], px[i + 2]) >= 60) {
          rsBright.push(px[i]);
          gsBright.push(px[i + 1]);
          bsBright.push(px[i + 2]);
        }
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
    // Rust 侧是 rs.is_empty() 才放弃；亮样本不足 8 个时退回全量样本（说明这图本身就是暗色背景）
    if (rs.length === 0) return { dataB64, method: "chroma" };
    const median = (v: number[]) => v.slice().sort((a, b) => a - b)[(v.length / 2) | 0];
    const useBright = rsBright.length >= 8;
    const bgR = median(useBright ? rsBright : rs);
    const bgG = median(useBright ? gsBright : gs);
    const bgB = median(useBright ? bsBright : bs);

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
    // 口径必须与 Rust cutout.rs 的 count_transparent 一致：只统计 alpha == 0 的「真透明」像素。
    // 原实现用 px[i] < 250，把羽化带和任何半透明像素都算成「已抠除」，与桌面端的判定
    // 分母含义不同 —— 同一张带柔和阴影/暗角（≥60% 像素 alpha 1~249）的立绘，
    // 桌面端判定 0.0 < 0.6 正常抠图，Web 端却算出 65% >= 0.6 判为 skip-overcut
    // 并原样返回，背景被留在图里。
    let removed = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] === 0) removed++;
    if (removed === 0) return { dataB64, method: "chroma" };
    // 非绿底且透明占比过高 → 疑似把主体误抠掉：保留原图（对齐 Rust skip-overcut），交回前端提示
    if (!green && removed / (w * h) >= 0.6) {
      return { dataB64, method: "skip-overcut" };
    }
    ctx.putImageData(imageData, 0, 0);
    return { dataB64: canvas.toDataURL("image/png").split(",")[1] ?? dataB64, method: "chroma" };
  } catch (e) {
    // #1309：异常不再伪装成 {method:"chroma"} 成功返回（调用方会当处理过写盘）。
    // 直接抛出，调用方走既有的"抠图失败，保留原图"显式回退（含日志），不静默产出假成功。
    throw e instanceof Error ? e : new Error(`浏览器端抠图失败：${String(e).slice(0, 160)}`);
  }
}
