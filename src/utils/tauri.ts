import { invoke } from "@tauri-apps/api/core";
import * as web from "./webRuntime";
import { log, truncate } from "./logger";

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

function b64encode(data: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data).toString("base64");
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function httpFallback(args: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutSecs?: number;
}): Promise<HttpResult> {
  if (web.isWeb()) return web.webHttp(args);
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

async function readTextFallback(path: string): Promise<{ text: string; encoding: string }> {
  if (web.isWeb()) return web.webReadTextFile(path);
  const fs = await import("node:fs/promises");
  const data = await fs.readFile(path);
  const decoder = new TextDecoder("utf-8");
  const text = decoder.decode(data);
  return { text, encoding: "UTF-8" };
}

async function writeTextFallback(path: string, content: string): Promise<void> {
  if (web.isWeb()) return web.webWriteTextFile(path, content);
  const fs = await import("node:fs/promises");
  await fs.mkdir(path.substring(0, path.lastIndexOf("/")), { recursive: true });
  await fs.writeFile(path, content, "utf-8");
}

async function readFileBase64Fallback(path: string): Promise<string> {
  if (web.isWeb()) return web.webReadFileBase64(path);
  const fs = await import("node:fs/promises");
  const data = await fs.readFile(path);
  return b64encode(new Uint8Array(data));
}

async function writeFileBase64Fallback(path: string, dataB64: string): Promise<void> {
  if (web.isWeb()) return web.webWriteFileBase64(path, dataB64);
  const fs = await import("node:fs/promises");
  const buf = Buffer.from(dataB64, "base64");
  await fs.mkdir(path.substring(0, path.lastIndexOf("/")), { recursive: true });
  await fs.writeFile(path, buf);
}

async function listDirFallback(path: string): Promise<FsEntry[]> {
  if (web.isWeb()) return web.webListDir(path);
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
    log.debug("tauri", `调用 ${name}`, truncate(args.length === 1 ? args[0] : args));
    try {
      const r = fn(...args);
      if (r instanceof Promise) {
        return r.then(
          (v) => {
            log.debug("tauri", `调用 ${name} → 成功`, truncate(v));
            return v;
          },
          (e: unknown) => {
            const errText = e instanceof Error ? e.message : String(e);
            // 预期内失败不刷 ERROR：文件不存在（首次生成前无 assets.json）、
            // 网络瞬时失败（调用方有重试）都降级为 warn/debug，避免日志噪音掩盖真实错误。
            const level = failureLogLevel(name, errText);
            log[level]("tauri", `调用 ${name} 失败`, {
              args: truncate(args.length === 1 ? args[0] : args),
              error: errText,
            });
            throw e;
          },
        ) as R;
      }
      log.debug("tauri", `调用 ${name} → 成功`, truncate(r));
      return r;
    } catch (e) {
      const errText = e instanceof Error ? e.message : String(e);
      const level = failureLogLevel(name, errText);
      log[level]("tauri", `调用 ${name} 失败`, {
        args: truncate(args.length === 1 ? args[0] : args),
        error: errText,
      });
      throw e;
    }
  };
}

/** 决定 tauri 调用失败的日志级别：文件不存在/网络瞬时失败为低级别，其余为 ERROR */
function failureLogLevel(name: string, errText: string): "error" | "warn" | "debug" {
  if (name === "readTextFile" && /ENOENT|os error 2|No such file|找不到指定的文件|不存在/i.test(errText)) {
    return "debug";
  }
  if (name === "http" && /error sending request|请求失败|timed? out|ECONN|ETIMEDOUT|fetch failed|Could not connect/i.test(errText)) {
    return "warn";
  }
  return "error";
}

export const tauri = {
  http: wrap("http", (args: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutSecs?: number;
  }): Promise<HttpResult> => {
    if (isTauri()) return invoke("http_request", { args });
    return httpFallback(args);
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
    if (web.isWeb()) return web.webMkdirAll(path);
    return import("node:fs/promises").then(async (fs) => {
      await fs.mkdir(path, { recursive: true });
    });
  }),
  copyFile: wrap("copyFile", (src: string, dst: string): Promise<void> => {
    if (isTauri()) return invoke("copy_file", { src, dst });
    if (web.isWeb()) return web.webCopyFile(src, dst);
    return import("node:fs/promises").then(async (fs) => {
      await fs.mkdir(dst.substring(0, dst.lastIndexOf("/")), { recursive: true });
      await fs.copyFile(src, dst);
    });
  }),
  copyDirAll: wrap("copyDirAll", (src: string, dst: string): Promise<void> => {
    if (isTauri()) return invoke("copy_dir_all", { src, dst });
    if (web.isWeb()) return web.webCopyDirAll(src, dst);
    return import("node:fs/promises").then(async (fs) => {
      await fs.cp(src, dst, { recursive: true });
    });
  }),
  replacePath: wrap("replacePath", (src: string, dst: string): Promise<void> => {
    if (isTauri()) return invoke("replace_path", { src, dst });
    if (web.isWeb()) return web.webReplacePath(src, dst);
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
  removePath: wrap("removePath", (path: string): Promise<void> => {
    if (isTauri()) return invoke("remove_path", { path });
    if (web.isWeb()) return web.webRemovePath(path);
    return import("node:fs/promises").then(async (fs) => {
      await fs.rm(path, { recursive: true, force: true });
    });
  }),
  pathExists: wrap("pathExists", (path: string): Promise<boolean> => {
    if (isTauri()) return invoke("path_exists", { path });
    if (web.isWeb()) return web.webPathExists(path);
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
    if (web.isWeb()) return Promise.resolve("/app/template");
    return Promise.resolve("/root/my_project/novelforge/resources");
  }),
  readConfig: wrap("readConfig", (): Promise<string> => {
    if (isTauri()) return invoke("read_config");
    if (web.isWeb()) return web.webReadConfig();
    return Promise.resolve("{}");
  }),
  writeConfig: wrap("writeConfig", (content: string): Promise<void> => {
    if (isTauri()) return invoke("write_config", { content });
    if (web.isWeb()) return web.webWriteConfig(content);
    return Promise.resolve();
  }),
  startPreviewServer: wrap("startPreviewServer", (root: string): Promise<{ url: string; port: number }> => {
    if (isTauri()) return invoke("start_preview_server", { root });
    if (web.isWeb()) return web.webStartPreviewServer(root);
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
    if (web.isWeb()) return Promise.resolve("/app/exports");
    return Promise.resolve("/root/my_project/game");
  }),
  cutoutImage: wrap("cutoutImage", (dataB64: string, threshold?: number): Promise<{ dataB64: string; method: string }> => {
    if (isTauri())
      return invoke("cutout_image", { dataB64, threshold: threshold ?? 40 }).then((r) => r as { dataB64: string; method: string });
    if (web.isWeb()) return web.webCutoutImage(dataB64, threshold).then((dataB64) => ({ dataB64, method: "chroma" }));
    return Promise.resolve({ dataB64, method: "chroma" });
  }),
  hasTransparency: wrap("hasTransparency", (dataB64: string): Promise<boolean> => {
    if (isTauri()) return invoke("has_transparency", { dataB64 });
    if (web.isWeb()) return web.webHasTransparency(dataB64);
    // Node 环境无解码能力：视为已透明，跳过抠图（避免损坏文件）
    return Promise.resolve(true);
  }),
  openUrl: wrap("openUrl", (url: string): Promise<void> => {
    if (isTauri()) return invoke("open_url", { url });
    if (web.isWeb()) {
      window.open(url, "_blank");
      return Promise.resolve();
    }
    return Promise.resolve();
  }),
  buildZip: wrap("buildZip", (sourceDir: string, zipPath: string, exclude: string[]): Promise<{ fileCount: number; sizeBytes: number }> => {
    if (isTauri()) return invoke("build_zip", { sourceDir, zipPath, exclude });
    if (web.isWeb()) return web.webBuildZip(sourceDir, zipPath, exclude);
    return Promise.reject(new Error("Web 环境不支持打包"));
  }),
  /** 判断图片文件尺寸是否匹配目标宽高（读 PNG/JPEG 文件头，纯前端实现） */
  imageSizeMatches: wrap("imageSizeMatches", async (path: string, targetWidth: number, targetHeight: number): Promise<boolean> => {
    try {
      const b64 = await tauri.readFileBase64(path);
      const buf = base64ToBuffer(b64);
      const size = detectImageSize(buf);
      if (!size) return true; // 无法识别 → 不阻断（保守放行）
      return size.width === targetWidth && size.height === targetHeight;
    } catch {
      return true; // 读取失败 → 放行（后续生成/缓存逻辑兜底）
    }
  }),
};
