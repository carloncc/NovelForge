import { invoke } from "@tauri-apps/api/core";
import * as web from "./webRuntime";

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

export const tauri = {
  http(args: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutSecs?: number;
  }): Promise<HttpResult> {
    if (isTauri()) return invoke("http_request", args);
    return httpFallback(args);
  },
  readTextFile(path: string): Promise<{ text: string; encoding: string }> {
    if (isTauri()) return invoke("read_text_file", { path });
    return readTextFallback(path);
  },
  writeTextFile(path: string, content: string): Promise<void> {
    if (isTauri()) return invoke("write_text_file", { path, content });
    return writeTextFallback(path, content);
  },
  readFileBase64(path: string): Promise<string> {
    if (isTauri()) return invoke("read_file_base64", { path });
    return readFileBase64Fallback(path);
  },
  writeFileBase64(path: string, dataB64: string): Promise<void> {
    if (isTauri()) return invoke("write_file_base64", { path, dataB64 });
    return writeFileBase64Fallback(path, dataB64);
  },
  listDir(path: string): Promise<FsEntry[]> {
    if (isTauri()) return invoke("list_dir", { path });
    return listDirFallback(path);
  },
  mkdirAll(path: string): Promise<void> {
    if (isTauri()) return invoke("mkdir_all", { path });
    if (web.isWeb()) return web.webMkdirAll(path);
    return import("node:fs/promises").then(async (fs) => {
      await fs.mkdir(path, { recursive: true });
    });
  },
  copyFile(src: string, dst: string): Promise<void> {
    if (isTauri()) return invoke("copy_file", { src, dst });
    if (web.isWeb()) return web.webCopyFile(src, dst);
    return import("node:fs/promises").then(async (fs) => {
      await fs.mkdir(dst.substring(0, dst.lastIndexOf("/")), { recursive: true });
      await fs.copyFile(src, dst);
    });
  },
  copyDirAll(src: string, dst: string): Promise<void> {
    if (isTauri()) return invoke("copy_dir_all", { src, dst });
    if (web.isWeb()) return web.webCopyDirAll(src, dst);
    return import("node:fs/promises").then(async (fs) => {
      await fs.cp(src, dst, { recursive: true });
    });
  },
  removePath(path: string): Promise<void> {
    if (isTauri()) return invoke("remove_path", { path });
    if (web.isWeb()) return web.webRemovePath(path);
    return import("node:fs/promises").then(async (fs) => {
      await fs.rm(path, { recursive: true, force: true });
    });
  },
  pathExists(path: string): Promise<boolean> {
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
  },
  appConfigDir(): Promise<string> {
    if (isTauri()) return invoke("app_config_dir");
    return Promise.resolve("/app/config");
  },
  resourceDir(): Promise<string> {
    if (isTauri()) return invoke("resource_dir");
    if (web.isWeb()) return Promise.resolve("/app/template");
    return Promise.resolve("/root/my_project/novelforge/resources");
  },
  readConfig(): Promise<string> {
    if (isTauri()) return invoke("read_config");
    if (web.isWeb()) return web.webReadConfig();
    return Promise.resolve("{}");
  },
  writeConfig(content: string): Promise<void> {
    if (isTauri()) return invoke("write_config", { content });
    if (web.isWeb()) return web.webWriteConfig(content);
    return Promise.resolve();
  },
  startPreviewServer(root: string): Promise<{ url: string; port: number }> {
    if (isTauri()) return invoke("start_preview_server", { root });
    if (web.isWeb()) return web.webStartPreviewServer(root);
    return Promise.reject(new Error("Web 环境不支持预览服务器"));
  },
  stopPreviewServer(): Promise<void> {
    if (isTauri()) return invoke("stop_preview_server");
    return Promise.resolve();
  },
  openInExplorer(path: string): Promise<void> {
    if (isTauri()) return invoke("open_in_explorer", { path });
    return Promise.resolve();
  },
  getDefaultOutputDir(): Promise<string> {
    if (isTauri()) return invoke("get_default_output_dir");
    if (web.isWeb()) return Promise.resolve("/app/exports");
    return Promise.resolve("/root/my_project/game");
  },
  cutoutImage(dataB64: string, threshold?: number): Promise<string> {
    if (isTauri()) return invoke("cutout_image", { dataB64, threshold: threshold ?? 40 });
    if (web.isWeb()) return web.webCutoutImage(dataB64, threshold);
    return Promise.resolve(dataB64);
  },
  hasTransparency(dataB64: string): Promise<boolean> {
    if (isTauri()) return invoke("has_transparency", { dataB64 });
    if (web.isWeb()) return web.webHasTransparency(dataB64);
    // Node 环境无解码能力：视为已透明，跳过抠图（避免损坏文件）
    return Promise.resolve(true);
  },
  openUrl(url: string): Promise<void> {
    if (isTauri()) return invoke("open_url", { url });
    if (web.isWeb()) {
      window.open(url, "_blank");
      return Promise.resolve();
    }
    return Promise.resolve();
  },
  buildZip(sourceDir: string, zipPath: string, exclude: string[]): Promise<{ fileCount: number; sizeBytes: number }> {
    if (isTauri()) return invoke("build_zip", { sourceDir, zipPath, exclude });
    if (web.isWeb()) return web.webBuildZip(sourceDir, zipPath, exclude);
    return Promise.reject(new Error("Web 环境不支持打包"));
  },
};
