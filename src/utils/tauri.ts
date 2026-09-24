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

function base64ToBuffer(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

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

async function readTextFallback(path: string): Promise<{ text: string; encoding: string }> {
  if (isWebRuntime()) return (await webRuntime()).webReadTextFile(path);
  const fs = await import("node:fs/promises");
  const data = await fs.readFile(path);
  const decoder = new TextDecoder("utf-8");
  const text = decoder.decode(data);
  return { text, encoding: "UTF-8" };
}

async function writeTextFallback(path: string, content: string): Promise<void> {
  if (isWebRuntime()) return (await webRuntime()).webWriteTextFile(path, content);
  const fs = await import("node:fs/promises");
  await fs.mkdir(path.substring(0, path.lastIndexOf("/")), { recursive: true });
  await fs.writeFile(path, content, "utf-8");
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
  const buf = Buffer.from(dataB64, "base64");
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

/** 决定 tauri 调用失败的日志级别：文件不存在/网络瞬时失败为低级别，其余为 ERROR */
function failureLogLevel(name: string, errText: string): "error" | "warn" | "debug" {
  if (
    (name === "readTextFile" || name === "readFileBase64" || name === "hasTransparency" || name === "pathExists")
    && /ENOENT|os error 2|No such file|找不到指定的文件|不存在/i.test(errText)
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
   *  读入内存并 base64 编码，只为解析 4 字节宽高）；Web/Node 无对应命令，回退 readFileBase64。 */
  imageSizeMatches: wrap("imageSizeMatches", async (path: string, targetWidth: number, targetHeight: number): Promise<boolean> => {
    try {
      let buf: Uint8Array;
      if (isTauri()) {
        // 4KB 足以覆盖典型文件头；JPEG 的 SOF 段可能排在 EXIF(APP1) 之后，512B 有漏判风险。
        // Rust 侧对 maxBytes 封顶 64KB，绝不会把整文件读进来。
        const header = (await invoke("read_file_header", { path, maxBytes: 4096 })) as { base64?: string };
        buf = header.base64 ? base64ToBuffer(header.base64) : new Uint8Array();
      } else {
        buf = base64ToBuffer(await tauri.readFileBase64(path));
      }
      const size = detectImageSize(buf);
      // 无法识别/解析失败 → 不合格（触发重生成）。旧实现一律放行，会让尺寸错误但文件名
      // 命中的缓存图被当成合格复用。
      return size !== null && size.width === targetWidth && size.height === targetHeight;
    } catch {
      // 读取失败同样视为不合格（文件缺失/损坏本就该重新生成）
      return false;
    }
  }),
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
