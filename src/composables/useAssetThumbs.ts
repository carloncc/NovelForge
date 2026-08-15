import { ref } from "vue";
import { tauri } from "../utils/tauri";

/**
 * 素材缩略图/试听：把本地文件读成 base64 data-URL。
 * - 共享缓存，同一路径只读一次；
 * - 失败路径记入 failed 集合，避免空字符串触发「加载失败→重渲染→再加载」死循环（导致崩溃）；
 * - 并发上限 4，防止一次性读几十张大图卡死界面。
 */

const MAX_CONCURRENT = 4;

const cache = ref<Record<string, string>>({});
const failed = new Map<string, number>();
const inflight = new Set<string>();
const pending: string[] = [];

// 失败路径的退避时间：避免「生成过程中文件还没落盘 → 读取失败 → 永久 failed」导致缩略图必须点一下才加载
const FAIL_RETRY_MS = 5000;

export function mimeOf(p: string): string {
  const l = p.toLowerCase();
  if (l.endsWith(".png")) return "image/png";
  if (l.endsWith(".jpg") || l.endsWith(".jpeg")) return "image/jpeg";
  if (l.endsWith(".webp")) return "image/webp";
  if (l.endsWith(".gif")) return "image/gif";
  if (l.endsWith(".mp3")) return "audio/mpeg";
  if (l.endsWith(".ogg")) return "audio/ogg";
  if (l.endsWith(".wav")) return "audio/wav";
  if (l.endsWith(".opus")) return "audio/opus";
  return "application/octet-stream";
}

async function loadOne(p: string): Promise<void> {
  try {
    const b64 = await tauri.readFileBase64(p);
    cache.value[p] = `data:${mimeOf(p)};base64,${b64}`;
    failed.delete(p);
  } catch {
    // 失败带时间戳；退避结束后自动重新入队重试（文件可能在生成中/刚写入），无需用户点击
    failed.set(p, Date.now());
    const t = window.setTimeout(() => {
      window.clearTimeout(t);
      if (!cache.value[p] && !inflight.has(p)) {
        failed.delete(p);
        pending.push(p);
        pump();
      }
    }, FAIL_RETRY_MS);
  }
}

function pump(): void {
  while (inflight.size < MAX_CONCURRENT && pending.length) {
    const p = pending.shift()!;
    const failedAt = failed.get(p);
    if (cache.value[p] || inflight.has(p)) continue;
    if (failedAt !== undefined && Date.now() - failedAt < FAIL_RETRY_MS) continue;
    failed.delete(p);
    inflight.add(p);
    loadOne(p).finally(() => {
      inflight.delete(p);
      pump();
    });
  }
}

/** 触发加载；立即返回（若已加载则返回 data-URL），加载完成后通过 cache 响应式更新 */
export function loadAssetDataUrl(p: string): string {
  if (!p) return "";
  if (cache.value[p]) return cache.value[p];
  const failedAt = failed.get(p);
  if (failedAt !== undefined && Date.now() - failedAt < FAIL_RETRY_MS) {
    // 退避中：不返回空字符串导致显示失败图标，而是延迟到退避结束后自动重试；
    // 但此刻 cache 无值，调用方应显示「加载中」而非「失败」。这里仍安排一次重试确保恢复。
    return "";
  }
  if (!inflight.has(p)) {
    pending.push(p);
    pump();
  }
  return cache.value[p];
}

/** 供模板直接使用：返回当前 data-URL（可能为空，加载完成后自动更新），失败/空路径返回空且不重试 */
export function useAssetThumbs() {
  return { thumbCache: cache, loadAssetDataUrl, mimeOf };
}

/** 清除指定路径的缓存（或全部）：素材被重新生成/覆盖同名文件后调用，强制 UI 重新读取新图 */
export function clearThumbCache(paths?: string[]): void {
  if (paths && paths.length) {
    for (const p of paths) {
      delete cache.value[p];
      failed.delete(p);
    }
  } else {
    for (const key of Object.keys(cache.value)) delete cache.value[key];
    failed.clear();
  }
}

/** 等待加载完成（用于试听等需要拿到结果的场景）；失败或超时返回空字符串 */
export function ensureAssetLoaded(p: string): Promise<string> {
  if (!p) return Promise.resolve("");
  if (cache.value[p]) return Promise.resolve(cache.value[p]);
  loadAssetDataUrl(p);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cache.value[p]) {
        clearInterval(iv);
        resolve(cache.value[p]);
      } else if (failed.has(p) || Date.now() - t0 > 30000) {
        clearInterval(iv);
        resolve("");
      }
    }, 120);
  });
}
