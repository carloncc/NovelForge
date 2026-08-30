/**
 * 浏览器版（web 运行时）AI 抠图模型下载器。
 * 移植自「抠图」项目 scripts/model-downloader.mjs：
 * - 断点续传（.part 文件 + Range 头）
 * - 连接失败重试（指数退避，12 次封顶）
 * - md5 完整性校验（失败重下，3 轮）
 * 写入 <项目根>/public/models/，dev/preview server 的 /__novelforge/model 中间件据此服务。
 * 环境变量：ISNET_MODEL_URL 可覆盖下载源（镜像）。
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_DIR = resolve(ROOT, "public", "models");

const CONNECT_TIMEOUT_MS = 30_000;
const MAX_CONNECT_ATTEMPTS = 12;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function modelDir() {
  return MODELS_DIR;
}

export function modelPath(filename) {
  return resolve(MODELS_DIR, filename);
}

export function installedModelFile(filename) {
  return existsSync(modelPath(filename));
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
    let response = null;
    try {
      response = await fetch(url, { ...options, redirect: "follow", signal: controller.signal });
    } catch (error) {
      lastError = error;
      console.warn(`[model-download] 第 ${attempt}/${MAX_CONNECT_ATTEMPTS} 次连接失败：${error.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (response && !RETRYABLE_STATUS.has(response.status)) {
      console.log(`[model-download] 连接成功：HTTP ${response.status}，耗时 ${Date.now() - startedAt} ms`);
      return response;
    }
    if (response) {
      lastError = new Error(`HTTP ${response.status}`);
      console.warn(`[model-download] 收到可重试状态 HTTP ${response.status}，第 ${attempt}/${MAX_CONNECT_ATTEMPTS} 次`);
    }
    if (attempt < MAX_CONNECT_ATTEMPTS) {
      const code = lastError?.cause?.code ?? lastError?.code ?? lastError?.message;
      process.stdout.write(`\r连接失败（${code}），${Math.min(attempt, 8)} 秒后重试 ${attempt}/${MAX_CONNECT_ATTEMPTS}…`);
      await sleep(1000 * Math.min(attempt, 8));
    }
  }
  throw lastError ?? new Error("无法连接下载源");
}

async function downloadToPart(filename, part, url, { onProgress }) {
  let attempt = 0;
  const effectiveUrl = process.env.ISNET_MODEL_URL ?? url;
  while (true) {
    attempt += 1;
    const offset = existsSync(part) ? statSync(part).size : 0;
    if (offset > 0 && attempt === 1) {
      process.stdout.write(`检测到未完成下载 ${(offset / 1048576).toFixed(1)} MB，将断点续传…\n`);
    }
    console.log(`[model-download] ${filename} 第 ${attempt} 轮开始，断点偏移 ${offset} 字节（${(offset / 1048576).toFixed(1)} MB）`);

    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
    const response = await fetchWithRetry(effectiveUrl, { headers });

    if (response.status === 200) {
      if (offset > 0) {
        console.log("下载源不支持断点续传，将从头重新下载…");
        unlinkSync(part);
      }
    } else if (response.status !== 206) {
      throw new Error(`下载失败：HTTP ${response.status}`);
    }

    const total = offset + (Number(response.headers.get("content-length")) || 0);
    const writer = createWriteStream(part, { flags: "a" });
    const reader = response.body.getReader();
    let downloaded = offset;
    let failed = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!writer.write(value)) await new Promise((resolveDrain) => writer.once("drain", resolveDrain));
        downloaded += value.length;
        process.stdout.write(`\r下载中 ${(downloaded / 1048576).toFixed(1)} MB / ${(total / 1048576).toFixed(1)} MB${attempt > 1 ? `（第 ${attempt} 次续传）` : ""}`);
        onProgress?.({ bytes: downloaded, total });
      }
    } catch (error) {
      failed = true;
      console.warn(`[model-download] 读取中断：${error.message}`);
    } finally {
      await new Promise((resolveClose) => writer.end(resolveClose));
    }

    if (!failed) {
      console.log(`\n[model-download] 第 ${attempt} 轮完成，累计 ${(downloaded / 1048576).toFixed(1)} MB`);
      return;
    }
    process.stdout.write(`\r连接中断（第 ${attempt} 次），${Math.min(attempt, 8)} 秒后续传…`);
    await sleep(1000 * Math.min(attempt, 8));
  }
}

function fileMd5(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("md5");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
    stream.on("error", rejectHash);
  });
}

export async function installModel({ filename, url, md5 }, { onProgress } = {}) {
  mkdirSync(MODELS_DIR, { recursive: true });
  const destination = modelPath(filename);
  const part = resolve(MODELS_DIR, `${filename}.part`);
  const startedAt = Date.now();
  const checksumNote = md5 ? `md5=${md5}` : "未设置 md5（跳过完整性校验）";
  console.log(`[model-download] 开始下载 ${filename}（${checksumNote}）到 ${destination}`);
  for (let round = 1; round <= 3; round += 1) {
    await downloadToPart(filename, part, url, { onProgress });
    process.stdout.write("\n正在校验完整性…\n");
    const digest = await fileMd5(part);
    console.log(`[model-download] 第 ${round} 轮下载完成，md5=${digest}`);
    if (!md5 || digest === md5) {
      renameSync(part, destination);
      console.log(`[model-download] ${md5 ? "md5 校验通过" : "完整性校验跳过（md5 未设置）"}，模型已就位，总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
      return { destination };
    }
    process.stderr.write(`第 ${round} 轮下载校验失败（md5=${digest}，期望 ${md5}），将重新下载。\n`);
    unlinkSync(part);
  }
  throw new Error("多次下载均未通过 md5 校验，请检查网络或设置 ISNET_MODEL_URL 指向镜像");
}
