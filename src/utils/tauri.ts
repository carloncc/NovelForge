import { invoke } from "@tauri-apps/api/core";
import { log, truncate } from "./logger";
import { b64decode, b64encode } from "./base64";

let webRuntimePromise: Promise<typeof import("./webRuntime")> | undefined;

function isWebRuntime(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function webRuntime(): Promise<typeof import("./webRuntime")> {
  webRuntimePromise ??= import("./webRuntime");
  return webRuntimePromise;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export interface HttpResult {
  status: number;
  contentType: string;
  bodyBase64: string;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** AI 抠图模型下载/安装状态（Tauri 与 web 运行时共用） */
export interface CutoutModelStatus {
  modelId: string;
  state: "idle" | "downloading" | "done" | "error";
  bytes: number;
  total: number;
  error: string | null;
  installed: boolean;
  /** 安装判定依据（#1129）：missing / ok / corrupt（Rust 侧返回，旧状态缺省时为 undefined） */
  integrity?: string;
  integrity_reason?: string | null;
  /** 当前实际使用的模型目录（#1130：用户可写目录，不再是 resource_dir） */
  dir?: string | null;
  /** 目录是否可写：false 时下载必然失败，需提示用户改用便携版/手动放置 */
  writable?: boolean;
}

export interface CutoutModelDownloadRequest {
  modelId: string;
  filename: string;
  url: string;
  md5?: string;
}

// #1532：原本是一份只走 atob 的副本，与同文件下方 writeFileBase64Fallback 里的
// `Buffer.from(x, "base64")` 各行其是（一个对非法输入抛错、一个静默返回 0 字节）。
// 统一走 base64.ts 的严格解码。
const base64ToBuffer = b64decode;

/** 从文件头识别图片尺寸（支持 PNG / JPEG / WebP / GIF） */
function detectImageSize(buf: Uint8Array): { width: number; height: number } | null {
  // PNG: 8 字节签名 + 4 长度 + "IHDR" + 宽(4) 高(4)
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // JPEG: FF D8 ... FF C0/C1/C2 段
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset++; continue; }
      const marker = buf[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: (buf[offset + 7] << 8) | buf[offset + 8], height: (buf[offset + 5] << 8) | buf[offset + 6] };
      }
      const len = (buf[offset + 2] << 8) | buf[offset + 3];
      offset += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP + VP8/VP8L/VP8X
  if (buf.length >= 30 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    const isWebp = buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
    if (isWebp) {
      const chunk = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
      if (chunk === "VP8X") {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        return { width: 1 + (dv.getUint32(24, true) & 0xffffff), height: 1 + (dv.getUint32(27, true) & 0xffffff) };
      }
      if (chunk === "VP8L") {
        const b = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const bits = b.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8 ") {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
      }
    }
    return null;
  }
  // GIF: GIF8 宽(2) 高(2)
  if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf[6] | (buf[7] << 8), height: buf[8] | (buf[9] << 8) };
  }
  return null;
}

async function httpFallback(args: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  timeoutSecs?: number;
}, signal?: AbortSignal): Promise<HttpResult> {
  if (isWebRuntime()) return (await webRuntime()).webHttp({ ...args, signal });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (args.timeoutSecs ?? 120) * 1000);
  // 外部中止（「停止」）与超时共用一个 controller：任一触发即中断 fetch
  const onAbort = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const resp = await fetch(args.url, {
      method: args.method,
      headers: args.headers,
      body: args.bodyBase64 ? base64ToBuffer(args.bodyBase64) : args.body,
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
    signal?.removeEventListener("abort", onAbort);
  }
}

/* #784：在途 HTTP 请求取消。每个带 signal 的 Tauri 请求分配 requestId，
   abort 时调用 Rust cancel_http_request 中断 reqwest 请求（AbortHandle.abort）。 */
let nextHttpRequestId = 1;
async function invokeHttpWithCancel(
  args: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    bodyBase64?: string;
    timeoutSecs?: number;
  },
  signal?: AbortSignal,
): Promise<HttpResult> {
  if (!signal) return invoke("http_request", { args });
  if (signal.aborted) throw new Error("已中止");
  const requestId = nextHttpRequestId++;
  const onAbort = (): void => {
    void invoke("cancel_http_request", { requestId }).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await invoke("http_request", { args, requestId });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Rust 侧流式增量事件负载（emit("nf-http-stream")） */
interface HttpStreamPayload {
  requestId?: number;
  dataBase64?: string;
}

/**
 * 流式 HTTP（仅剧本路径使用；仅 Tauri 桌面端）：
 * 与 tauri.http 相同的入参/返回值契约（返回完整响应体，取消语义一致），额外通过 Rust 的
 * nf-http-stream 事件把响应增量边收边交给 onChunk（base64 → UTF-8 文本）。
 * 非 Tauri（网页版）返回 null，调用方静默回退整包请求（拿不到流式接口不报错）。
 */
export async function httpStream(
  args: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    bodyBase64?: string;
    timeoutSecs?: number;
    /** #1411：用户显式放行局域网/本机其它端口（与 tauri.http 同口径透传给 Rust） */
    allowLan?: boolean;
  },
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<HttpResult | null> {
  if (!isTauri()) return null;
  if (signal?.aborted) throw new Error("已中止");
  // 动态 import：网页版/Node 测试不加载事件模块
  const { listen } = await import("@tauri-apps/api/event");
  // 始终分配 requestId：Rust 侧按它给事件打标（并发流式请求不会串台），同时沿用同一套取消语义
  const requestId = nextHttpRequestId++;
  const decoder = new TextDecoder("utf-8");
  const onAbort = (): void => {
    void invoke("cancel_http_request", { requestId }).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<HttpStreamPayload>("nf-http-stream", (event) => {
      const payload = event.payload;
      if (!payload || payload.requestId !== requestId || typeof payload.dataBase64 !== "string") return;
      // stream:true 的 decoder：UTF-8 多字节字符被 emit 边界截断时留到下一段再解，避免乱码/计数虚高
      onChunk(decoder.decode(b64decode(payload.dataBase64), { stream: true }));
    });
    // listen 是异步的：等待期间被中止时不能再发出请求（否则无人取消，等于对已取消的请求继续计费）
    if (signal?.aborted) throw new Error("已中止");
    log.debug("tauri", "调用 httpStream", { method: args.method, url: args.url, timeoutSecs: args.timeoutSecs });
    return (await invoke("http_request", { args: { ...args, stream: true }, requestId })) as HttpResult;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    unlisten?.();
  }
}

/** Node 侧可试解的传统中文/日韩编码，按常见度排序 */
const LEGACY_TEXT_ENCODINGS = ["gbk", "big5", "shift_jis", "euc-kr"] as const;

/** 文本"像不像正常中文/日韩文"：含替换字符直接判负（该编码解释不了这份字节）。
 *  只为在多个都能解码的候选（GBK 与 Big5 高度重叠）之间择优。 */
function cjkPlausibility(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfffd) return -1;
    if (cp < 0x20 && ch !== "\n" && ch !== "\r" && ch !== "\t") return -1;
    total++;
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0xac00 && cp <= 0xd7af)) cjk++;
  }
  return total ? cjk / total : 0;
}

/**
 * Node 侧文本解码：与 Rust 的 read_text_file（src-tauri/src/commands.rs）同口径。
 *
 * 旧实现是 \`new TextDecoder("utf-8").decode(data)\` 且恒定返回 \`encoding: "UTF-8"\` ——
 * 对 GBK/Shift_JIS 等非 UTF-8 文件既产出乱码、又**谎报**编码。这不是"少个功能"：
 * ① 分章快照指纹是 \`\${fullText.length}:\${hash}\`，乱码长度对不上 → 快照被判为"源文件已变"而丢弃，
 *    AI 分好的章节退回正则重切；
 * ② 任何 Node 侧无头验证（测试/脚本）都会得出与应用内**相反**的结论 —— 本次排查就用它
 *    复现出过"30 章变 1 章"的假 bug，差点当成真缺陷上报。
 * Rust 侧走 chardetng；这里没有统计模型，退化为「严格 UTF-8 → 传统编码试解 → 择优」，
 * 覆盖 GBK/Big5/Shift_JIS/EUC-KR；仍无法判定时与 Rust 一致返回 lossy + "unknown"。
 */
function decodeTextLikeBackend(data: Uint8Array): { text: string; encoding: string } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(data), encoding: "UTF-8" };
  } catch {
    /* 不是合法 UTF-8，继续探测传统编码 */
  }
  let best: { text: string; encoding: string; score: number } | null = null;
  for (const enc of LEGACY_TEXT_ENCODINGS) {
    let text: string;
    try {
      text = new TextDecoder(enc, { fatal: true }).decode(data);
    } catch {
      continue; // 该编码无法解释这份字节
    }
    const score = cjkPlausibility(text);
    if (score < 0) continue;
    if (!best || score > best.score) best = { text, encoding: enc.toUpperCase(), score };
  }
  if (best && best.score > 0.3) return { text: best.text, encoding: best.encoding };
  return { text: new TextDecoder("utf-8").decode(data), encoding: "unknown" };
}

async function readTextFallback(path: string): Promise<{ text: string; encoding: string }> {
  if (isWebRuntime()) return (await webRuntime()).webReadTextFile(path);
  const fs = await import("node:fs/promises");
  const data = await fs.readFile(path);
  return decodeTextLikeBackend(data);
}

async function writeTextFallback(path: string, content: string): Promise<void> {
  if (isWebRuntime()) return (await webRuntime()).webWriteTextFile(path, content);
  const fs = await import("node:fs/promises");
  await fs.mkdir(path.substring(0, path.lastIndexOf("/")), { recursive: true });
  await fs.writeFile(path, content, "utf-8");
}

/** 追加写入的兜底实现：无 append 能力的后端退化为「读 + 拼 + 写」。
 *  Rust 桌面版有真正的 O_APPEND（append_text_file），Web/Node 走这里。 */
async function appendTextFallback(path: string, content: string): Promise<void> {
  if (isWebRuntime()) {
    const web = await webRuntime();
    const existing = await web.webReadTextFile(path).catch(() => ({ text: "" }));
    return web.webWriteTextFile(path, existing.text + content);
  }
  const fs = await import("node:fs/promises");
  await fs.mkdir(path.substring(0, path.lastIndexOf("/")), { recursive: true });
  await fs.appendFile(path, content, "utf-8");
}

async function readFileBase64Fallback(path: string): Promise<string> {
  if (isWebRuntime()) return (await webRuntime()).webReadFileBase64(path);
  const fs = await import("node:fs/promises");
  const data = await fs.readFile(path);
  return b64encode(new Uint8Array(data));
}

async function writeFileBase64Fallback(path: string, dataB64: string): Promise<void> {
  if (isWebRuntime()) return (await webRuntime()).webWriteFileBase64(path, dataB64);
  const fs = await import("node:fs/promises");
  // #1532：与 base64ToBuffer 统一，避免同一文件里两种解码行为
  const buf = b64decode(dataB64);
  await fs.mkdir(path.substring(0, path.lastIndexOf("/")), { recursive: true });
  await fs.writeFile(path, buf);
}

async function listDirFallback(path: string): Promise<FsEntry[]> {
  if (isWebRuntime()) return (await webRuntime()).webListDir(path);
  const fs = await import("node:fs/promises");
  const entries = await fs.readdir(path, { withFileTypes: true });
  return entries
    .filter((e) => !e.name.startsWith("."))
    .map((e) => ({
      name: e.name,
      path: `${path}/${e.name}`,
      isDir: e.isDirectory(),
      size: 0,
    }));
}

/** 包装 Tauri/fallback 方法：记录入参、成功/失败日志（开发环境） */
function wrap<A extends unknown[], R>(name: string, fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    const loggedArgs = safeCallArgs(name, args.length === 1 ? args[0] : args);
    log.debug("tauri", `调用 ${name}`, loggedArgs);
    try {
      const r = fn(...args);
      if (r instanceof Promise) {
        return r.then(
          (v) => {
            log.debug("tauri", `调用 ${name} → 成功`, safeCallResult(name, v));
            return v;
          },
          (e: unknown) => {
            const errText = e instanceof Error ? e.message : String(e);
            // 预期内失败不刷 ERROR：文件不存在（首次生成前无 assets.json）、
            // 网络瞬时失败（调用方有重试）都降级为 warn/debug，避免日志噪音掩盖真实错误。
            const level = failureLogLevel(name, errText);
            log[level]("tauri", `调用 ${name} 失败`, {
              args: loggedArgs,
              error: errText,
            });
            throw e;
          },
        ) as R;
      }
      log.debug("tauri", `调用 ${name} → 成功`, safeCallResult(name, r));
      return r;
    } catch (e) {
      const errText = e instanceof Error ? e.message : String(e);
      const level = failureLogLevel(name, errText);
      log[level]("tauri", `调用 ${name} 失败`, {
        args: loggedArgs,
        error: errText,
      });
      throw e;
    }
  };
}

function safeCallArgs(name: string, args: unknown): unknown {
  if (name === "writeConfig" || name === "writeApiSecrets") return "[REDACTED]";
  if (name === "http" && args && typeof args === "object") {
    const request = args as Record<string, unknown>;
    return truncate({ method: request.method, url: request.url, timeoutSecs: request.timeoutSecs, binaryBodySize: typeof request.bodyBase64 === "string" ? request.bodyBase64.length : 0 });
  }
  if (name === "writeFileBase64") {
    const value = args as { path?: string; dataB64?: string };
    return { path: value.path, size: value.dataB64?.length ?? 0 };
  }
  return truncate(args);
}

function safeCallResult(name: string, result: unknown): unknown {
  if (name === "readConfig" || name === "readApiSecrets") return "[REDACTED]";
  if (result instanceof ArrayBuffer || ArrayBuffer.isView(result)) {
    // 二进制大对象（如 zip 字节）绝不能进日志序列化：截断字符串化会把主线程拖死
    return `[binary ${(result as ArrayBufferView | ArrayBuffer).byteLength ?? 0} bytes]`;
  }
  if (name === "http" && result && typeof result === "object") {
    const response = result as Record<string, unknown>;
    return {
      status: response.status,
      contentType: response.contentType,
      bodySize: typeof response.bodyBase64 === "string" ? response.bodyBase64.length : 0,
    };
  }
  if (name === "readFileBase64" && typeof result === "string") return { size: result.length };
  return truncate(result);
}

/** 决定 tauri 调用失败的日志级别：文件不存在/网络瞬时失败为低级别，其余为 ERROR。
 *  导出仅为让单测能直接锁住判定表（本函数是纯函数，无副作用）。 */
export function failureLogLevel(name: string, errText: string): "error" | "warn" | "debug" {
  if (
    (name === "readTextFile" || name === "readFileBase64" || name === "hasTransparency" || name === "pathExists")
    // #1514：Windows 上「文件/目录不存在」返回的是 os error 3（ERROR_PATH_NOT_FOUND，
    // 中文「系统找不到指定的路径。」），不是 os error 2（ERROR_FILE_NOT_FOUND）。
    // 实测全量日志：os error 3 出现 790 次、os error 2 一次都没有 —— 说明这条降级分支
    // 在 Windows 上原本是死代码，探针式的缓存读取（每章一个 script_chN_*.json）
    // 全部以红色 ERROR 刷屏，把真正的错误淹掉。
    && /ENOENT|os error 2|os error 3|No such file|找不到指定的文件|找不到指定的路径|不存在/i.test(errText)
  ) {
    return "debug";
  }
  if (name === "http" && /error sending request|请求失败|timed? out|ECONN|ETIMEDOUT|fetch failed|Could not connect/i.test(errText)) {
    return "warn";
  }
  return "error";
}

/** Node 环境（单元测试/脚本）的默认目录：优先环境变量，其次当前工作目录下的 output。
 *  #1131：禁止再硬编码开发机绝对路径（如 /root/my_project/game）。 */
export function nodeDefaultDir(kind: "output" | "resources"): string {
  const fromEnv = typeof process !== "undefined" ? (process.env?.NOVELFORGE_OUTPUT_DIR ?? "").trim() : "";
  if (fromEnv) return kind === "output" ? fromEnv : `${fromEnv.replace(/\/+$/, "")}/resources`;
  if (typeof process !== "undefined" && typeof process.cwd === "function") {
    try {
      const cwd = process.cwd().replace(/\\/g, "/");
      return kind === "output" ? `${cwd}/output` : `${cwd}/resources`;
    } catch {
      /* 回退默认 */
    }
  }
  return kind === "output" ? "/app/exports" : "/app/template";
}

/** 登记文件所在目录（对话框选中文件后调用）：取父目录登记，失败静默
 *  （后续文件命令会给出明确拒绝，不在这里打断用户流程）。 */
export async function blessParentDir(filePath: string): Promise<void> {
  if (!isTauri() || !filePath) return;
  const parent = filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/") || filePath;
  try {
    await tauri.blessProjectDir(parent);
  } catch {
    /* 登记失败不阻断，后续文件命令会给出明确拒绝 */
  }
}

export const tauri = {
  http: wrap("http", (args: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    bodyBase64?: string;
    timeoutSecs?: number;
  }, signal?: AbortSignal): Promise<HttpResult> => {
    if (isTauri()) return invokeHttpWithCancel(args, signal);
    return httpFallback(args, signal);
  }),
  readTextFile: wrap("readTextFile", (path: string): Promise<{ text: string; encoding: string }> => {
    if (isTauri()) return invoke("read_text_file", { path });
    return readTextFallback(path);
  }),
  writeTextFile: wrap("writeTextFile", (path: string, content: string): Promise<void> => {
    if (isTauri()) return invoke("write_text_file", { path, content });
    return writeTextFallback(path, content);
  }),
  /** #1514：给随包脚本加执行位。macOS 的 .command 没有执行位时，Finder 双击不会运行，
   *  只会报权限错误或用编辑器打开——而导出说明恰恰让用户双击它。
   *  Web 端文件系统（IndexedDB）无权限位概念，直接成功返回。 */
  setExecutable: wrap("setExecutable", (path: string): Promise<void> => {
    if (isTauri()) return invoke("set_file_executable", { path });
    return Promise.resolve();
  }),
  /** #1502：追加写入。日志落盘用它取代「读全量 + 写全量」，成本与新增行数成正比。
   *  无 append 能力的后端自动退化为读改写。 */
  appendTextFile: wrap("appendTextFile", (path: string, content: string): Promise<void> => {
    if (isTauri()) return invoke("append_text_file", { path, content });
    return appendTextFallback(path, content);
  }),
  readFileBase64: wrap("readFileBase64", (path: string): Promise<string> => {
    if (isTauri()) return invoke("read_file_base64", { path });
    return readFileBase64Fallback(path);
  }),
  writeFileBase64: wrap("writeFileBase64", (path: string, dataB64: string): Promise<void> => {
    if (isTauri()) return invoke("write_file_base64", { path, dataB64 });
    return writeFileBase64Fallback(path, dataB64);
  }),
  listDir: wrap("listDir", (path: string): Promise<FsEntry[]> => {
    if (isTauri()) return invoke("list_dir", { path });
    return listDirFallback(path);
  }),
  mkdirAll: wrap("mkdirAll", (path: string): Promise<void> => {
    if (isTauri()) return invoke("mkdir_all", { path });
    if (isWebRuntime()) return webRuntime().then((web) => web.webMkdirAll(path));
    return import("node:fs/promises").then(async (fs) => {
      await fs.mkdir(path, { recursive: true });
    });
  }),
  /** 登记用户自选目录（#1292）：桌面端文件白名单只放行工作目录/临时目录/家目录 +
   *  此处登记的目录。切换项目、系统对话框选中文件/目录后调用——用户已明示授权。
   *  非桌面端为 no-op（网页版走 VFS/代理，不受 Rust 白名单约束）。 */
  blessProjectDir: wrap("blessProjectDir", async (path: string): Promise<void> => {
    if (!isTauri()) return;
    await invoke("bless_project_dir", { path });
  }),
  copyFile: wrap("copyFile", (src: string, dst: string): Promise<void> => {
    if (isTauri()) return invoke("copy_file", { src, dst });
    if (isWebRuntime()) return webRuntime().then((web) => web.webCopyFile(src, dst));
    return import("node:fs/promises").then(async (fs) => {
      await fs.mkdir(dst.substring(0, dst.lastIndexOf("/")), { recursive: true });
      await fs.copyFile(src, dst);
    });
  }),
  copyDirAll: wrap("copyDirAll", (src: string, dst: string): Promise<void> => {
    if (isTauri()) return invoke("copy_dir_all", { src, dst });
    if (isWebRuntime()) return webRuntime().then((web) => web.webCopyDirAll(src, dst));
    return import("node:fs/promises").then(async (fs) => {
      await fs.cp(src, dst, { recursive: true });
    });
  }),
  replacePath: wrap("replacePath", (src: string, dst: string): Promise<void> => {
    if (isTauri()) return invoke("replace_path", { src, dst });
    if (isWebRuntime()) return webRuntime().then((web) => web.webReplacePath(src, dst));
    return import("node:fs/promises").then(async (fs) => {
      const backup = `${dst}.replace-backup`;
      await fs.rm(backup, { recursive: true, force: true });
      const destinationExists = await fs.access(dst).then(() => true).catch(() => false);
      if (destinationExists) await fs.rename(dst, backup);
      try {
        await fs.rename(src, dst);
      } catch (error) {
        if (destinationExists) {
          try {
            await fs.rename(backup, dst);
          } catch (rollbackError) {
            const replaceMessage = error instanceof Error ? error.message : String(error);
            const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            throw new Error(`Path replacement failed (${replaceMessage}); rollback also failed (${rollbackMessage})`);
          }
        }
        throw error;
      }
      try {
        await fs.rm(backup, { recursive: true, force: true });
      } catch (error) {
        log.warn("tauri", "Path replacement backup cleanup failed", {
          backup,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }),
  /** 启动清理崩溃残留（#783）：删除本程序原子写留下的 .tmp、恢复/清理 .replace-backup。
   *  仅 Tauri 运行时产生这类文件；Web/Node 直接返回 0。 */
  cleanupStaleFiles: wrap("cleanupStaleFiles", (root: string, maxDepth?: number): Promise<{ removed: number; restored: number }> => {
    if (isTauri()) return invoke("cleanup_stale_files", { root, maxDepth }) as Promise<{ removed: number; restored: number }>;
    return Promise.resolve({ removed: 0, restored: 0 });
  }),
  removePath: wrap("removePath", (path: string): Promise<void> => {    if (isTauri()) return invoke("remove_path", { path });
    if (isWebRuntime()) return webRuntime().then((web) => web.webRemovePath(path));
    return import("node:fs/promises").then(async (fs) => {
      await fs.rm(path, { recursive: true, force: true });
    });
  }),
  pathExists: wrap("pathExists", (path: string): Promise<boolean> => {
    if (isTauri()) return invoke("path_exists", { path });
    if (isWebRuntime()) return webRuntime().then((web) => web.webPathExists(path));
    return import("node:fs/promises").then(async (fs) => {
      try {
        await fs.access(path);
        return true;
      } catch {
        return false;
      }
    });
  }),
  appConfigDir: wrap("appConfigDir", (): Promise<string> => {
    if (isTauri()) return invoke("app_config_dir");
    return Promise.resolve("/app/config");
  }),
  resourceDir: wrap("resourceDir", (): Promise<string> => {
    if (isTauri()) return invoke("resource_dir");
    if (isWebRuntime()) return Promise.resolve("/app/template");
    // #1131：Node 分支取当前工作目录（可用 NOVELFORGE_OUTPUT_DIR 覆盖），不保留开发机路径
    return Promise.resolve(nodeDefaultDir("resources"));
  }),
  readConfig: wrap("readConfig", (): Promise<string> => {
    if (isTauri()) return invoke("read_config");
    if (isWebRuntime()) return webRuntime().then((web) => web.webReadConfig());
    return Promise.resolve("{}");
  }),
  writeConfig: wrap("writeConfig", (content: string): Promise<void> => {
    if (isTauri()) return invoke("write_config", { content });
    if (isWebRuntime()) return webRuntime().then((web) => web.webWriteConfig(content));
    return Promise.resolve();
  }),
  readApiSecrets: wrap("readApiSecrets", (ids: string[]): Promise<Record<string, string>> => {
    if (isTauri()) return invoke("read_api_secrets", { ids });
    if (isWebRuntime()) return webRuntime().then((web) => web.webReadApiSecrets(ids));
    return Promise.resolve({});
  }),
  writeApiSecrets: wrap("writeApiSecrets", (secrets: Record<string, string>): Promise<void> => {
    if (isTauri()) return invoke("write_api_secrets", { secrets });
    if (isWebRuntime()) return webRuntime().then((web) => web.webWriteApiSecrets(secrets));
    return Promise.resolve();
  }),
  startPreviewServer: wrap("startPreviewServer", (root: string): Promise<{ url: string; port: number }> => {
    if (isTauri()) return invoke("start_preview_server", { root });
    if (isWebRuntime()) return webRuntime().then((web) => web.webStartPreviewServer(root));
    return Promise.reject(new Error("Web 环境不支持预览服务器"));
  }),
  stopPreviewServer: wrap("stopPreviewServer", (): Promise<void> => {
    if (isTauri()) return invoke("stop_preview_server");
    return Promise.resolve();
  }),
  openInExplorer: wrap("openInExplorer", (path: string): Promise<void> => {
    if (isTauri()) return invoke("open_in_explorer", { path });
    return Promise.resolve();
  }),
  getDefaultOutputDir: wrap("getDefaultOutputDir", (): Promise<string> => {
    if (isTauri()) return invoke("get_default_output_dir");
    if (isWebRuntime()) return Promise.resolve("/app/exports");
    // #1131：Node 分支取环境变量 NOVELFORGE_OUTPUT_DIR 或当前工作目录 output，不保留开发机路径
    return Promise.resolve(nodeDefaultDir("output"));
  }),
  cutoutImage: wrap("cutoutImage", (dataB64: string, threshold?: number): Promise<{ dataB64: string; method: string }> => {
    if (isTauri())
      return invoke("cutout_image", { dataB64, threshold: threshold ?? 40 }).then((r) => r as { dataB64: string; method: string });
    if (isWebRuntime()) {
      // Web 版返回真实 method（chroma/skip-dark/skip-overcut）：旧实现恒报 chroma，
      // 导致深色/过激保护在前端成死代码、绿幕图被当成功写盘
      return webRuntime().then((web) => web.webCutoutImage(dataB64, threshold));
    }
    return Promise.resolve({ dataB64, method: "chroma" });
  }),
  hasTransparency: wrap("hasTransparency", (dataB64: string): Promise<boolean> => {
    if (isTauri()) return invoke("has_transparency", { dataB64 });
    if (isWebRuntime()) return webRuntime().then((web) => web.webHasTransparency(dataB64));
    // Node 环境无解码能力：视为已透明，跳过抠图（避免损坏文件）
    return Promise.resolve(true);
  }),
  openUrl: wrap("openUrl", (url: string): Promise<void> => {
    if (isTauri()) return invoke("open_url", { url });
    if (isWebRuntime()) {
      window.open(url, "_blank");
      return Promise.resolve();
    }
    return Promise.resolve();
  }),
  buildZip: wrap("buildZip", (sourceDir: string, zipPath: string, exclude: string[]): Promise<{ fileCount: number; sizeBytes: number }> => {
    if (isTauri()) return invoke("build_zip", { sourceDir, zipPath, exclude });
    return Promise.reject(new Error("网页版请使用 downloadZipWeb"));
  }),
  /** 判断图片文件尺寸是否匹配目标宽高（读 PNG/JPEG/WebP/GIF 文件头）
   *  B85：Tauri 环境改用 read_file_header 只读文件头（旧实现 readFileBase64 会把整张图
   *  读入内存并 base64 编码，只为解析 4 字节宽高）；Web/Node 无对应命令，回退 readFileBase64。
   *
   *  #1489：返回值从 boolean 改为三态。旧实现把「解析不出尺寸」与「尺寸确实不符」都返回 false，
   *  调用方据此直接删掉缓存图并重新生成——而带大 EXIF/ICC 的 JPEG 其 SOF 段排在 4KB 之后，
   *  「解析不出」会被误判成「尺寸不符」，于是**已付费的图被反复删除重画**。现在把两种情形分开：
   *  - mismatch：确实能解析出尺寸且与要求不符 → 可安全重新生成
   *  - unknown ：读不出/解析不出（含上限外的文件头）→ 保留既有图片，不当作损坏 */
  imageSizeMatches: wrap(
    "imageSizeMatches",
    async (path: string, targetWidth: number, targetHeight: number): Promise<"ok" | "mismatch" | "unknown"> => {
      try {
        let buf: Uint8Array;
        if (isTauri()) {
          // 64KB：JPEG 的 SOF 段可能排在 EXIF(APP1)/ICC(APP2) 之后，4KB 会漏判（Rust 侧封顶 64KB，
          // 绝不会把整文件读进来）。
          const header = (await invoke("read_file_header", { path, maxBytes: 65536 })) as { base64?: string };
          buf = header.base64 ? base64ToBuffer(header.base64) : new Uint8Array();
        } else {
          // #1503：Web/Node 没有 read_file_header，此前退回 readFileBase64 会**把整张图读进来**，
          // 只为解析头部几个字节（Tauri 侧早已改成只读文件头）。这里在拿到 base64 之后立刻截断：
          // 头部最多需要 64KB，按 base64 的 4/3 比例取对应字符数（并对齐到 4 的倍数，
          // 避免截在半路让解码器报错）。内存占用从「整图」降到「56KB 字符串」。
          const raw = await tauri.readFileBase64(path);
          buf = base64ToBuffer(sliceBase64Head(raw, IMAGE_HEADER_BYTES));
        }
        const size = detectImageSize(buf);
        if (!size) return "unknown";
        return size.width === targetWidth && size.height === targetHeight ? "ok" : "mismatch";
      } catch {
        // 读取失败：无法证明图片有问题，按 unknown 处理（绝不据此删图）
        return "unknown";
      }
    },
  ),
  cutoutModelStatus: wrap("cutoutModelStatus", (modelId: string, filename: string): Promise<CutoutModelStatus> => {
    if (isTauri()) return invoke("model_download_status", { modelId, filename }).then((r) => r as CutoutModelStatus);
    if (isWebRuntime()) return webRuntime().then((web) => web.webCutoutModelStatus(modelId, filename));
    return Promise.resolve({ modelId, state: "idle", bytes: 0, total: 0, error: null, installed: false });
  }),
  cutoutModelDownload: wrap("cutoutModelDownload", (req: CutoutModelDownloadRequest): Promise<CutoutModelStatus> => {
    if (isTauri()) {
      return invoke("model_download_start", {
        modelId: req.modelId,
        filename: req.filename,
        url: req.url,
        md5: req.md5 ?? "",
      }).then((r) => r as CutoutModelStatus);
    }
    if (isWebRuntime()) return webRuntime().then((web) => web.webCutoutModelDownload(req));
    return Promise.reject(new Error("当前环境不支持模型下载"));
  }),
  cutoutModelRemove: wrap("cutoutModelRemove", (modelId: string, filename: string): Promise<void> => {
    if (isTauri()) return invoke("model_remove", { modelId, filename }).then(() => undefined);
    if (isWebRuntime()) return webRuntime().then((web) => web.webCutoutModelRemove(modelId, filename));
    return Promise.resolve();
  }),
};

/**
 * 解析图片尺寸所需的最大头部字节数。
 *
 * **与 Rust 侧 `READ_FILE_HEADER_LIMIT`（commands.rs:20，`64 * 1024`）是一对跨语言常量**：
 * 原来这里只是注释声称「与 Rust 封顶一致」，没有东西保证。跨语言没法共享常量，
 * 所以改为导出、并由 tests/unit-cross-lang-constants.ts 读 Rust 源码求值后比对——
 * 任何一侧被改而另一侧没跟，门禁就会红。（同会话 #1548/#1536/#1565 都是「口径一致只靠注释」栽的坑。）
 */
export const IMAGE_HEADER_BYTES = 65536;

/**
 * 从 base64 字符串中截出「足够解析文件头」的前缀（#1503）。
 * - 每 3 字节编码成 4 个字符，故前缀字符数 = ceil(bytes / 3) * 4；
 * - 必须先按 4 的倍数对齐再交给解码器，否则末尾是不完整 quartet，解码会抛错或丢字节。
 */
export function sliceBase64Head(b64: string, bytes: number): string {
  if (!b64) return b64;
  const chars = Math.ceil(bytes / 3) * 4;
  // bytes<=0（非正上限）时不做截断：截成空串会让调用方以为"文件是空的"，
  // 反而制造出比"多读一点"更糟的误判。
  if (chars <= 0 || b64.length <= chars) return b64;
  return b64.slice(0, chars - (chars % 4));
}


/**
 * 目标 zip 是否位于源目录内部（#1116）：桌面版把包存到项目目录里时，Rust 先创建 zip 再遍历源目录，
 * 正在写入的 zip 自身会成为打包条目（半成品副本）。比较前统一分隔符、去掉尾斜杠与冗余「.」段；
 * Windows 盘符/路径大小写不敏感，这里统一按小写比较（Linux 上极少数大小写不同的路径会被保守拒绝）。
 */
export function isPathInsideDir(dir: string, target: string): boolean {
  const norm = (p: string): string => {
    const parts = p.replace(/\\/g, "/").split("/");
    const out: string[] = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") {
        out.pop();
        continue;
      }
      out.push(part.toLowerCase());
    }
    return out.join("/");
  };
  const d = norm(dir);
  const t = norm(target);
  return d.length > 0 && t.startsWith(`${d}/`);
}

/**
 * 网页版专用：打包 zip 并在浏览器中直接下载。
 * 大字节不进 tauri 日志包装层（成功日志会 truncate 序列化返回值，47MB 会被拖成分钟级）。
 */
export async function downloadZipWeb(
  sourceDir: string,
  exclude: string[],
  downloadName: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ fileCount: number; sizeBytes: number }> {
  if (!isWebRuntime()) throw new Error("当前环境不是网页版");
  const web = await webRuntime();
  return web.webDownloadZip(sourceDir, exclude, downloadName, onProgress);
}
