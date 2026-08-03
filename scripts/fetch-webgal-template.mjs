#!/usr/bin/env node
/**
 * 获取 WebGAL 引擎模板（构建/运行所需）。
 * 用法：pnpm prepare:template
 * 下载官方 WebGAL 网页版包 → 解压 → 裁剪 demo 内容 → src-tauri/templates/webgal
 */
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "src-tauri", "templates", "webgal");
const VERSION = "4.6.3";
const URLS = [
  `https://github.com/OpenWebGAL/WebGAL/releases/download/${VERSION}/WebGAL-${VERSION}-web.zip`,
  `https://ghfast.top/https://github.com/OpenWebGAL/WebGAL/releases/download/${VERSION}/WebGAL-${VERSION}-web.zip`,
];
const DOWNLOAD_TIMEOUT_MS = 300_000;

// 裁剪：引擎运行时不需要的演示内容（字体等保留）
const REMOVE = [
  "game/vocal",
  "game/bgm",
  "game/video",
  "game/scene",
  "game/background",
  "game/figure",
];

async function download(url, dest) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(res.body, createWriteStream(dest));
  } finally {
    clearTimeout(timer);
  }
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const index = join(TARGET, "index.html");
  if (await exists(index)) {
    console.log(`引擎模板已存在：${TARGET}`);
    return;
  }

  const zip = join(ROOT, ".template-cache", `WebGAL-${VERSION}-web.zip`);
  await mkdir(dirname(zip), { recursive: true });

  let lastErr;
  for (const url of URLS) {
    try {
      console.log(`下载引擎模板：${url}`);
      await download(url, zip);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`下载失败（${e.message}），尝试下一个源…`);
    }
  }
  if (lastErr) throw lastErr;

  console.log("解压中…");
  await rm(TARGET, { recursive: true, force: true });
  await mkdir(TARGET, { recursive: true });
  const unzip = spawnSync("unzip", ["-o", zip, "-d", TARGET], { stdio: "ignore" });
  if (unzip.status !== 0) {
    // Windows runner：尝试 PowerShell Expand-Archive
    const ps = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${zip}' -DestinationPath '${TARGET}'`],
      { stdio: "ignore" },
    );
    if (ps.status !== 0) {
      // 通用兜底：python3 / python
      let pyOk = false;
      for (const py of ["python3", "python"]) {
        const r = spawnSync(
          py,
          ["-c", `import zipfile; zipfile.ZipFile(r"${zip}").extractall(r"${TARGET}")`],
          { stdio: "ignore" },
        );
        if (r.status === 0) {
          pyOk = true;
          break;
        }
      }
      if (!pyOk) {
        throw new Error("解压失败：需要 unzip / powershell / python 之一");
      }
    }
  }

  console.log("裁剪演示内容…");
  for (const p of REMOVE) {
    await rm(join(TARGET, p), { recursive: true, force: true });
  }
  // 清理无用的 .gz 预压缩副本（本地服务器不使用）
  for (const f of await readdir(join(TARGET, "assets"))) {
    if (f.endsWith(".gz")) {
      await rm(join(TARGET, "assets", f), { force: true });
    }
  }
  await rm(zip, { force: true });

  console.log(`引擎模板就绪：${TARGET}`);
}

main().catch((e) => {
  console.error("获取引擎模板失败：", e.message);
  process.exit(1);
});
