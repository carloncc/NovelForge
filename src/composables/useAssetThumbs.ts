import { ref, type Ref } from "vue";
import { tauri } from "../utils/tauri";
import { log } from "../utils/logger";

/**
 * 素材缩略图/试听：把本地文件读成 base64 data-URL。
 * - 共享缓存，同一路径只读一次；
 * - 失败路径记入 failed 集合，避免空字符串触发「加载失败→重渲染→再加载」死循环（导致崩溃）；
 * - 并发上限 4，防止一次性读几十张大图卡死界面。
 *
 * 图片缩略图「按需降采样」：
 * 缩略图只用于 120px 高的小尺寸展示，却长期持有 1024² 原图的 data-URL（base64 约 1.4MB/张），
 * 64MB 预算只装约 45 张，而单章节有 84 个分镜 → 每次加载新图都会 LRU 淘汰旧图 → 旧图条目变空
 * 又触发重读 → 无限环路 → 所有图片反复「占位符↔图」，表现为狂闪。治本做法：拿到原图后，用
 * createImageBitmap/OffscreenCanvas（不可用则 <img>+<canvas> 兜底）把长边缩到 ≤320px，再编码为
 * webp(0.8)（webp 不可用按源格式回退）后缓存。环境不可用（jsdom/测试/老 webview）直接用原图
 * 兜底，绝不报错、不阻塞显示；大图预览/试听仍走 ensureAssetLoaded 读原图，语义不变。
 *
 * 搜索引擎核实结论（写代码时已查证）：
 * - MDN createImageBitmap：Baseline widely available（2021-09 起跨浏览器稳定）
 *   https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap
 * - MDN OffscreenCanvas.convertToBlob：Baseline widely available（2023-03 起）；若指定 type
 *   不被支持会回退 PNG 而不是报错，故代码需检查返回 Blob 的实际 type
 *   https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas/convertToBlob
 * - 浏览器每张已解码图片需持有 宽×高×4 字节的像素缓冲（RGBA，与压缩后大小无关，属通用图解模型）：
 *   1024² 约 4MB/张，320² 约 0.4MB/张，量级下降约 10 倍——这是「治本」的关键。
 */

const MAX_CONCURRENT = 4;

/** 缩略图长边上限（px）：120px 高展示没必要持全分辨率 */
const THUMB_MAX_EDGE = 320;
const THUMB_QUALITY = 0.8;

/** 同一路径两次「非显式」重读的最小间隔，避免淘汰/重读形成环路 */
const RELOAD_THROTTLE_MS = 2000;

/**
 * 缩略图预算：降采样后单张约 30–60KB（base64 约 0.02–0.05MB），96MB 可容纳约 2000–3000 张，
 * 远超单章节 84 个分镜 + 全项目常用素材，正常展示不再触发 LRU 淘汰（断环路的前提）。
 */
const MAX_CACHE_BYTES = 96 * 1024 * 1024;
/** 大图预览缓存预算：1024² PNG base64 约 1.4MB，48MB 约 34 张；预览只保留少量原图。 */
const MAX_FULL_CACHE_BYTES = 48 * 1024 * 1024;

const MAX_FAILURES = 4;

// 失败路径的退避时间：避免「生成过程中文件还没落盘 → 读取失败 → 永久 failed」导致缩略图必须点一下才加载
const FAIL_RETRY_MS = 5000;

/** 极简 LRU：用于缩略图与原图两套缓存，避免两处重复实现 */
interface LruStore {
  data: Ref<Record<string, string>>;
  sizes: Map<string, number>;
  access: Map<string, number>;
  bytes: number;
}

function createLru(): LruStore {
  return { data: ref<Record<string, string>>({}), sizes: new Map(), access: new Map(), bytes: 0 };
}

function lruPut(store: LruStore, path: string, value: string, budget: number): void {
  store.bytes -= store.sizes.get(path) ?? 0;
  store.data.value[path] = value;
  const size = Math.ceil(value.length * 0.75);
  store.sizes.set(path, size);
  store.access.set(path, Date.now());
  store.bytes += size;
  while (store.bytes > budget) {
    let oldest: string | undefined;
    let oldestAt = Infinity;
    for (const [key, at] of store.access) {
      if (key !== path && at < oldestAt) {
        oldest = key;
        oldestAt = at;
      }
    }
    if (!oldest) break;
    lruDelete(store, oldest);
  }
}

function lruDelete(store: LruStore, path: string): void {
  if (path in store.data.value) delete store.data.value[path];
  store.bytes -= store.sizes.get(path) ?? 0;
  store.sizes.delete(path);
  store.access.delete(path);
}

function lruClear(store: LruStore): void {
  for (const key of Object.keys(store.data.value)) delete store.data.value[key];
  store.sizes.clear();
  store.access.clear();
  store.bytes = 0;
}

const thumbStore = createLru();
const fullStore = createLru();
const cache = thumbStore.data;

const failed = new Map<string, number>();
const inflight = new Set<string>();
const pending: LoadJob[] = [];
const retryCounts = new Map<string, number>();
const retryTimers = new Map<string, number>();
const lastAttempt = new Map<string, number>();
let cacheGeneration = 0;
const pathGenerations = new Map<string, number>();

/**
 * 显式作废信号（仅供 LazyThumb 响应式监听）：
 * - pathInvalidations[p]：clearThumbCache([p]) 定向作废——只有该路径的组件会重新加载；
 * - invalidationEpoch：clearThumbCache() 全清——所有组件重新加载。
 * 关键：LRU 淘汰不经过这里，因此不会被误当成「显式作废」触发重读。
 */
const pathInvalidations = ref<Record<string, number>>({});
const invalidationEpoch = ref(0);

/** 读取某路径的显式作废版本；返回字符串便于 watch 按值比较 */
export function thumbInvalidationOf(path: string): string {
  return `${invalidationEpoch.value}:${pathInvalidations.value[path] ?? 0}`;
}

interface LoadJob {
  path: string;
  full: boolean;
}

function jobKey(job: LoadJob): string {
  return `${job.full ? "F" : "T"}:${job.path}`;
}

function isCached(path: string, full: boolean): boolean {
  return full ? Boolean(fullStore.data.value[path]) : Boolean(thumbStore.data.value[path]);
}

function loadIsCurrent(path: string, generation: number, pathGeneration: number): boolean {
  return generation === cacheGeneration && pathGeneration === (pathGenerations.get(path) ?? 0);
}

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

/** 可安全栅格化降采样的静态图片（GIF 会丢动画、SVG/音频不处理，一律保留原图） */
function isDownsamplableImage(path: string): boolean {
  const mime = mimeOf(path);
  return mime === "image/png" || mime === "image/jpeg" || mime === "image/webp";
}

/**
 * 计算降采样目标尺寸：长边 > maxEdge 才缩，返回 null 表示无需处理（保持原图、避免重编码掉画质）。
 * 抽成纯函数便于单测，不依赖任何 DOM。
 */
export function thumbTargetSize(
  width: number,
  height: number,
  maxEdge = THUMB_MAX_EDGE,
): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return null;
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function imageDownsampleAvailable(): boolean {
  if (typeof createImageBitmap === "function") return true;
  if (typeof OffscreenCanvas === "function") return true;
  return typeof document !== "undefined";
}

async function decodeImageSource(dataUrl: string): Promise<ImageBitmap | HTMLImageElement | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      if (blob.type.startsWith("image/")) return await createImageBitmap(blob);
    } catch {
      // 某些环境不能 fetch data: URL 或解码失败 → 下面用 <img> 兜底，不报错、不阻塞
    }
  }
  if (typeof document === "undefined") return null;
  return await new Promise<HTMLImageElement | null>((resolve) => {
    const img = document.createElement("img");
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function releaseSource(source: ImageBitmap | HTMLImageElement): void {
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) source.close();
}

/**
 * webp 不可用时的回退格式：PNG/WebP 源可能带透明通道，用 PNG（JPEG 会把透明烧成黑底）；
 * 仅 JPEG 源回退 JPEG。
 */
function thumbnailFallbackType(sourceMime: string): "image/jpeg" | "image/png" {
  return sourceMime === "image/jpeg" ? "image/jpeg" : "image/png";
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("读取图片 Blob 失败"));
    reader.readAsDataURL(blob);
  });
}

async function encodeOffscreen(canvas: OffscreenCanvas, sourceMime: string): Promise<Blob | null> {
  let fallback: Blob | null = null;
  try {
    const webp = await canvas.convertToBlob({ type: "image/webp", quality: THUMB_QUALITY });
    // convertToBlob 在不支持指定 type 时回退 PNG 而不报错，故必须校验实际 type
    if (webp.type === "image/webp") return webp;
    fallback = webp;
  } catch {
    // webp 编码异常 → 继续回退
  }
  try {
    const type = thumbnailFallbackType(sourceMime);
    return (await canvas.convertToBlob({ type, quality: THUMB_QUALITY })) ?? fallback;
  } catch {
    return fallback;
  }
}

function encodeCanvasElement(canvas: HTMLCanvasElement, sourceMime: string): string {
  const webp = canvas.toDataURL("image/webp", THUMB_QUALITY);
  if (webp.startsWith("data:image/webp")) return webp;
  const type = thumbnailFallbackType(sourceMime);
  const fallback = canvas.toDataURL(type, THUMB_QUALITY);
  return fallback.startsWith(`data:${type}`) ? fallback : webp;
}

/** 栅格化 + 缩放 + 编码；解码不可用或无需缩放时返回 null（调用方回退原图） */
async function downsampleDataUrl(dataUrl: string, sourceMime: string): Promise<string | null> {
  const source = await decodeImageSource(dataUrl);
  if (!source) return null;
  try {
    const target = thumbTargetSize(source.width, source.height);
    if (!target) return null;
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(target.width, target.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(source, 0, 0, target.width, target.height);
      const blob = await encodeOffscreen(canvas, sourceMime);
      return blob ? await blobToDataUrl(blob) : null;
    }
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = target.width;
      canvas.height = target.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(source, 0, 0, target.width, target.height);
      return encodeCanvasElement(canvas, sourceMime) || null;
    }
    return null;
  } finally {
    releaseSource(source);
  }
}

let downsampleWarned = false;
function warnDownsampleOnce(error: unknown): void {
  if (downsampleWarned) return;
  downsampleWarned = true;
  log.warn("asset-thumbs", "缩略图降采样失败，已回退原图", {
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * 把原图 data-URL 降采样成缩略图 data-URL；任何不可用/异常都优雅回退原图（绝不抛错、不阻塞显示）。
 * 导出以便单测在无 canvas 的 Node 环境验证「回退原图」。
 */
export async function buildThumbDataUrl(dataUrl: string, path: string): Promise<string> {
  if (!isDownsamplableImage(path)) return dataUrl;
  if (!imageDownsampleAvailable()) return dataUrl;
  try {
    const small = await downsampleDataUrl(dataUrl, mimeOf(path));
    // 编码反而更大时保留原图，保证内存只降不升
    return small && small.length < dataUrl.length ? small : dataUrl;
  } catch (error) {
    warnDownsampleOnce(error);
    return dataUrl;
  }
}

async function loadOne(job: LoadJob, generation: number, pathGeneration: number): Promise<void> {
  const p = job.path;
  try {
    const b64 = await tauri.readFileBase64(p);
    if (!loadIsCurrent(p, generation, pathGeneration)) return;
    const raw = `data:${mimeOf(p)};base64,${b64}`;
    if (job.full) {
      lruPut(fullStore, p, raw, MAX_FULL_CACHE_BYTES);
    } else {
      const thumb = await buildThumbDataUrl(raw, p);
      if (!loadIsCurrent(p, generation, pathGeneration)) return;
      lruPut(thumbStore, p, thumb, MAX_CACHE_BYTES);
    }
    failed.delete(p);
    retryCounts.delete(p);
  } catch {
    if (!loadIsCurrent(p, generation, pathGeneration)) return;
    // 失败带时间戳；退避结束后自动重新入队重试（文件可能在生成中/刚写入），无需用户点击
    failed.set(p, Date.now());
    const failures = (retryCounts.get(p) ?? 0) + 1;
    retryCounts.set(p, failures);
    if (failures >= MAX_FAILURES) return;
    // 同一路径可能同时有缩略图与全图两个任务失败：先清掉旧定时器，否则后者覆盖 map 里的句柄，
    // 旧回调触发时又会删掉**新**句柄，clearThumbCache 就再也取消不掉这个定时器。
    const prevTimer = retryTimers.get(p);
    if (prevTimer !== undefined) window.clearTimeout(prevTimer);
    const t = window.setTimeout(() => {
      if (retryTimers.get(p) === t) retryTimers.delete(p);
      if (loadIsCurrent(p, generation, pathGeneration) && !thumbStore.data.value[p] && !inflight.has(jobKey({ path: p, full: false }))) {
        failed.delete(p);
        pending.push({ path: p, full: false });
        pump();
      }
    }, FAIL_RETRY_MS);
    retryTimers.set(p, t);
  }
}

function pump(): void {
  while (inflight.size < MAX_CONCURRENT && pending.length) {
    const job = pending.shift()!;
    const key = jobKey(job);
    if (isCached(job.path, job.full) || inflight.has(key)) continue;
    const failedAt = failed.get(job.path);
    if (failedAt !== undefined && Date.now() - failedAt < FAIL_RETRY_MS) continue;
    failed.delete(job.path);
    inflight.add(key);
    const generation = cacheGeneration;
    const pathGeneration = pathGenerations.get(job.path) ?? 0;
    loadOne(job, generation, pathGeneration).finally(() => {
      inflight.delete(key);
      pump();
    });
  }
}

/** 入队一次读取；已缓存/在途/重复入队/退避中/超限时直接跳过 */
function requestLoad(path: string, full: boolean): void {
  if (!path || isCached(path, full)) return;
  if ((retryCounts.get(path) ?? 0) >= MAX_FAILURES) return;
  const failedAt = failed.get(path);
  if (failedAt !== undefined && Date.now() - failedAt < FAIL_RETRY_MS) return;
  const key = jobKey({ path, full });
  if (inflight.has(key)) return;
  if (pending.some((job) => job.path === path && job.full === full)) return;
  pending.push({ path, full });
  pump();
}

/** 触发加载；立即返回（若已加载则返回 data-URL），加载完成后通过 cache 响应式更新 */
export function loadAssetDataUrl(p: string): string {
  if (!p) return "";
  const cached = thumbStore.data.value[p];
  if (cached) {
    thumbStore.access.set(p, Date.now());
    return cached;
  }
  requestLoad(p, false);
  return thumbStore.data.value[p];
}

/** 供模板直接使用：返回当前 data-URL（可能为空，加载完成后自动更新），失败/空路径返回空且不重试 */
export function useAssetThumbs() {
  return { thumbCache: cache, loadAssetDataUrl, mimeOf };
}

/**
 * LazyThumb 自动重读的触发原因。
 * - explicit：clearThumbCache（素材覆盖重生成/映射刷新）——必须重读；
 * - evicted：LRU 因内存淘汰——不得重读（否则形成淘汰→重读→再淘汰的无限环路）；
 * - entered-view / path-change：进入视口 / 路径切换——受节流保护。
 */
type ThumbReloadReason = "explicit" | "evicted" | "entered-view" | "path-change";

interface ThumbReloadState {
  reason: ThumbReloadReason;
  inView: boolean;
  hasValue: boolean;
  msSinceLastLoad: number;
  throttleMs?: number;
}

/**
 * 纯函数判定「是否应自动重读缩略图」，抽出来便于单测：
 * - 已有值 / 不在视口 → 不重读；
 * - 显式作废 → 一定重读（覆盖同名文件后必须上屏）；
 * - LRU 淘汰 → 一定不重读（断掉狂闪环路）；
 * - 进入视口 / 路径切换 → 距上次读取不足节流间隔则跳过。
 */
export function shouldReloadThumb(state: ThumbReloadState): boolean {
  if (!state.inView || state.hasValue) return false;
  if (state.reason === "explicit") return true;
  if (state.reason === "evicted") return false;
  const throttle = state.throttleMs ?? RELOAD_THROTTLE_MS;
  return state.msSinceLastLoad >= throttle;
}

/** LazyThumb 统一入口：按纯函数判定并（可选）发起加载，同时记录本次尝试时间用于节流 */
export function requestThumbLoad(path: string, reason: ThumbReloadReason, inView: boolean): boolean {
  if (!path) return false;
  const allowed = shouldReloadThumb({
    reason,
    inView,
    hasValue: Boolean(thumbStore.data.value[path]),
    msSinceLastLoad: Date.now() - (lastAttempt.get(path) ?? 0),
  });
  if (!allowed) return false;
  lastAttempt.set(path, Date.now());
  loadAssetDataUrl(path);
  return true;
}

/**
 * 清除指定路径的缓存（或全部）：素材被重新生成/覆盖同名文件后调用，强制 UI 重新读取新图。
 * 定向作废语义保持不变；同时清除原图缓存与失败退避，并通过显式作废信号驱动 LazyThumb 重读。
 */
export function clearThumbCache(paths?: string[]): void {
  if (paths && paths.length) {
    for (const p of paths) {
      pathGenerations.set(p, (pathGenerations.get(p) ?? 0) + 1);
      const timer = retryTimers.get(p);
      if (timer !== undefined) window.clearTimeout(timer);
      retryTimers.delete(p);
      retryCounts.delete(p);
      failed.delete(p);
      // 重置节流基准：显式作废后允许立刻重读，不被上一次读取的 2s 节流挡住
      lastAttempt.delete(p);
      lruDelete(thumbStore, p);
      lruDelete(fullStore, p);
    }
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (paths.includes(pending[index].path)) pending.splice(index, 1);
    }
    const next = { ...pathInvalidations.value };
    for (const p of paths) next[p] = (next[p] ?? 0) + 1;
    pathInvalidations.value = next;
    return;
  }
  cacheGeneration += 1;
  pathGenerations.clear();
  for (const timer of retryTimers.values()) window.clearTimeout(timer);
  retryTimers.clear();
  retryCounts.clear();
  failed.clear();
  lastAttempt.clear();
  lruClear(thumbStore);
  lruClear(fullStore);
  pending.length = 0;
  pathInvalidations.value = {};
  invalidationEpoch.value += 1;
}

/**
 * 等待加载完成（用于大图预览/试听等需要拿到原图的场景）；失败或超时返回空字符串。
 * 语义保证：只从原图缓存 fullStore 取结果，绝不返回降采样后的缩略图。
 * 可选 signal：组件卸载或切换路径时中止 120ms 轮询，避免句柄泄漏和向已销毁组件回写。
 */
export function ensureAssetLoaded(p: string, signal?: AbortSignal): Promise<string> {
  if (!p || signal?.aborted) return Promise.resolve("");
  const cached = fullStore.data.value[p];
  if (cached) return Promise.resolve(cached);
  requestLoad(p, true);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const stop = (): void => {
      clearInterval(iv);
      resolve("");
    };
    const iv = setInterval(() => {
      if (signal?.aborted) {
        stop();
      } else if (fullStore.data.value[p]) {
        clearInterval(iv);
        resolve(fullStore.data.value[p]);
      } else if (failed.has(p) || Date.now() - t0 > 30000) {
        stop();
      }
    }, 120);
    signal?.addEventListener("abort", stop, { once: true });
  });
}
