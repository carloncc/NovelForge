/**
 * 立绘表情差分核验器（#1084）。
 * 算法与参数参考 TongjiAI4E/VN_Sprite_Expression_Workflow（MIT），详见仓库根 THIRD_PARTY_NOTICES.md：
 * 固定原图 alpha 与允许区外像素，只允许脸部/五官选区内变化；核验 outside_mask_exact + alpha_exact。
 * 本文件只做「只读校验」：不合格不改产物，由调用方记 warn + 失败项（可单张重生成）。
 */
import type { ImageTask } from "./types";
import { tauri } from "../utils/tauri";
import { imageMimeForPath } from "../utils/mime";
import { log as logger } from "../utils/logger";

/* ================= 掩膜参数（与校验阈值分离存放） =================
 * 纪律（借鉴其 AGENTS.md）：不得为了让校验通过而放宽掩膜；调掩膜只改本节，校验侧恒为逐像素精确一致。 */
export const SPRITE_MASK_EXPAND = 1.08;
export const SPRITE_MASK_FEATHER_PX_DEFAULT = 12;

/** 允许区椭圆（像素坐标，相对整图左上角） */
export interface SpriteEllipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface SpriteVerifyCounts {
  /** 画布尺寸是否不一致 */
  sizeMismatch: boolean;
  /** 整幅 alpha 与 base 不一致的像素数 */
  alphaMismatch: number;
  /** 允许区外（mask == 0）RGBA 与 base 不一致的像素数 */
  outsideMismatch: number;
  /** 上两项的并集像素数（报告用） */
  diffPixels: number;
  /** 差异像素的外包框（无差异时为 null） */
  diffBbox: { x0: number; y0: number; x1: number; y1: number } | null;
}

export interface SpriteVerifyResult extends SpriteVerifyCounts {
  width: number;
  height: number;
  ok: boolean;
}

/**
 * 核验容差（#1418）：允许区外像素的比对口径。缺省/严格模式三项均为 0 = 逐像素完全一致。
 * 生图/编辑路径是整幅扩散重绘 + 抠图，允许区外必然存在噪声，严格口径会系统性误杀。
 */
export interface SpriteVerifyTolerance {
  /** 每像素每通道允许的最大差值（0=严格逐像素）；差值 <= 该值不计失败 */
  channelTolerance: number;
  /** 允许的区外不一致像素数上限（0=不允许） */
  maxOutsideMismatch: number;
  /** 允许的 alpha 不一致像素数上限（0=不允许，alpha 仍按整幅比对） */
  maxAlphaMismatch: number;
}

/** 严格口径（合成等像素冻结产物用）：区外 RGBA 与整幅 alpha 必须逐像素一致 */
export const STRICT_VERIFY_TOLERANCE: SpriteVerifyTolerance = {
  channelTolerance: 0,
  maxOutsideMismatch: 0,
  maxAlphaMismatch: 0,
};

/** 扩散口径默认值：每通道 16、区外/alpha 差异各占整图 2%（#1418，仍能抓身体/衣物整体漂移） */
export const DIFFUSION_CHANNEL_TOLERANCE = 16;
export const DIFFUSION_DIFF_RATIO = 0.02;

/** 按画布面积换算扩散核验容差（差异像素上限随分辨率缩放） */
export function diffusionToleranceFor(width: number, height: number): SpriteVerifyTolerance {
  const cap = Math.ceil(Math.max(0, width * height) * DIFFUSION_DIFF_RATIO);
  return { channelTolerance: DIFFUSION_CHANNEL_TOLERANCE, maxOutsideMismatch: cap, maxAlphaMismatch: cap };
}

export function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

/**
 * 单点椭圆掩膜值（#1087 附录公式）：
 * q = hypot((x-cx)/(rx*1.08), (y-cy)/(ry*1.08))；mask = clamp(((1-q) * min(rx,ry)) / feather, 0, 1)。
 */
export function ellipseMaskAt(x: number, y: number, e: SpriteEllipse, featherPx: number): number {
  const rx = Math.max(1, e.rx * SPRITE_MASK_EXPAND);
  const ry = Math.max(1, e.ry * SPRITE_MASK_EXPAND);
  const q = Math.hypot((x - e.cx) / rx, (y - e.cy) / ry);
  const feather = featherPx > 0 ? featherPx : SPRITE_MASK_FEATHER_PX_DEFAULT;
  return clamp01(((1 - q) * Math.min(rx, ry)) / feather);
}

/** 允许区掩膜 = 全部椭圆掩膜的并集（取最大），返回 W*H 的 Float32Array（0..1）。 */
export function buildAllowedMask(
  width: number,
  height: number,
  ellipses: SpriteEllipse[],
  featherPx: number = SPRITE_MASK_FEATHER_PX_DEFAULT,
): Float32Array {
  const mask = new Float32Array(Math.max(0, width * height));
  if (width <= 0 || height <= 0) return mask;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let m = 0;
      for (const e of ellipses) {
        const v = ellipseMaskAt(x, y, e, featherPx);
        if (v > m) m = v;
        if (m >= 1) break;
      }
      mask[y * width + x] = m;
    }
  }
  return mask;
}

/**
 * 自动粗脸框（#1084「自动粗脸框」档）：无 rig/手动椭圆时的兜底允许区。
 * 取脸部大致位置（画面上中部），覆盖眉/眼/嘴；身体/衣服/发型一律在区外，必须与 base 逐像素一致。
 */
export function defaultCoarseFaceEllipse(width: number, height: number): SpriteEllipse {
  return {
    cx: width * 0.5,
    cy: height * 0.38,
    rx: Math.max(1, width * 0.22),
    ry: Math.max(1, height * 0.28),
  };
}

/* ================= 校验阈值（恒为精确一致，不可配） ================= */

/**
 * 三项校验（纯函数，逐像素）：
 * a) 已由调用方保证同尺寸（长度不符即 sizeMismatch，不合格）；
 * b) 允许区外（mask == 0）的 RGBA 与 base 逐像素一致（容差范围内）；
 * c) 整幅 alpha 通道与 base 一致（容差范围内）。
 * 允许区内（mask > 0）的 RGB 差异是合法的表情变化，不计数。
 * tolerance 缺省为严格逐像素（合成路径）；生图/编辑路径应传 diffusionToleranceFor(...)（#1418）。
 */
export function verifySpriteImage(
  base: Uint8Array | Uint8ClampedArray,
  variant: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  mask: Float32Array,
  tolerance: SpriteVerifyTolerance = STRICT_VERIFY_TOLERANCE,
): SpriteVerifyResult {
  const fail = (partial: Partial<SpriteVerifyCounts>): SpriteVerifyResult => ({
    width,
    height,
    ok: false,
    sizeMismatch: true,
    alphaMismatch: 0,
    outsideMismatch: 0,
    diffPixels: 0,
    diffBbox: null,
    ...partial,
  });
  if (width <= 0 || height <= 0) return fail({});
  if (base.length !== width * height * 4 || variant.length !== width * height * 4 || mask.length !== width * height) {
    return fail({});
  }
  const tol = Math.max(0, tolerance.channelTolerance);
  let alphaMismatch = 0;
  let outsideMismatch = 0;
  let diffPixels = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const alphaSame = Math.abs(base[o + 3] - variant[o + 3]) <= tol;
    if (!alphaSame) alphaMismatch++;
    let bad = !alphaSame;
    if (mask[i] <= 0) {
      const outsideSame = alphaSame
        && Math.abs(base[o] - variant[o]) <= tol
        && Math.abs(base[o + 1] - variant[o + 1]) <= tol
        && Math.abs(base[o + 2] - variant[o + 2]) <= tol;
      if (!outsideSame) outsideMismatch++;
      bad = bad || !outsideSame;
    }
    if (bad) {
      diffPixels++;
      const x = i % width;
      const y = Math.floor(i / width);
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  const ok = alphaMismatch <= tolerance.maxAlphaMismatch && outsideMismatch <= tolerance.maxOutsideMismatch;
  return {
    width,
    height,
    ok,
    sizeMismatch: false,
    alphaMismatch,
    outsideMismatch,
    diffPixels,
    diffBbox: diffPixels > 0 ? { x0, y0, x1, y1 } : null,
  };
}

/** 是否为表情差分任务（normal 底图本身不校验，只校验差分产物） */
export function isExpressionDiffTask(task: ImageTask): boolean {
  return task.kind === "figure" && !!task.emotion && task.emotion !== "normal";
}

/** 核验失败的日志/失败项文案（含差异像素数与差异 bbox，便于定位身体漂移还是衣服被改） */
export function formatSpriteVerifyFailure(taskLabel: string, r: SpriteVerifyResult): string {
  if (r.sizeMismatch) {
    return `表情差分核验未通过：${taskLabel}（画布尺寸与底图不一致 ${r.width}x${r.height}，可单张重生成）`;
  }
  const box = r.diffBbox ? `差异 bbox(${r.diffBbox.x0},${r.diffBbox.y0})-(${r.diffBbox.x1},${r.diffBbox.y1})` : "无差异 bbox";
  return `表情差分核验未通过：${taskLabel}（允许区外差异 ${r.outsideMismatch} 像素，alpha 差异 ${r.alphaMismatch} 像素，${box}；疑似身体/衣服/发型漂移，可单张重生成）`;
}

/** 核验报告 JSON（纯函数，供 QA 报告/总览表后续落盘使用） */
export function toVerifyReportJson(taskId: string, r: SpriteVerifyResult): string {
  return JSON.stringify({
    taskId,
    ok: r.ok,
    width: r.width,
    height: r.height,
    sizeMismatch: r.sizeMismatch,
    alphaMismatch: r.alphaMismatch,
    outsideMismatch: r.outsideMismatch,
    diffPixels: r.diffPixels,
    diffBbox: r.diffBbox,
    at: new Date().toISOString(),
  });
}

/* ================= 文件级核验（best-effort，只读） ================= */

export interface DecodedRgba {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function decodeDataUrlToRgba(dataUrl: string): Promise<DecodedRgba | null> {
  // Node 下无 canvas（单测/脚本环境）：返回 null 由调用方跳过，不记失败
  if (typeof document === "undefined" || typeof Image === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const el = new Image();
    el.onload = () => {
      try {
        const w = el.naturalWidth || el.width;
        const h = el.naturalHeight || el.height;
        if (!w || !h) {
          resolve(null);
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(el, 0, 0);
        const d = ctx.getImageData(0, 0, w, h);
        resolve({ data: d.data, width: w, height: h });
      } catch {
        resolve(null);
      }
    };
    el.onerror = () => resolve(null);
    el.src = dataUrl;
  });
}

/** 读图并解码为 RGBA；解码不可用/失败返回 null（调用方跳过，不记失败） */
export async function loadImageRgba(path: string): Promise<DecodedRgba | null> {
  try {
    const b64 = await tauri.readFileBase64(path);
    if (!b64 || !b64.trim()) return null;
    return await decodeDataUrlToRgba(`data:${imageMimeForPath(path)};base64,${b64}`);
  } catch (e) {
    logger.warn("spriteVerify", "核验读图失败（跳过本次核验，不影响主流程）", {
      path,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * 表情差分文件级核验（只读，不改产物）：
 * 返回 null = 跳过（Node 无解码能力/读图失败/缺少 base），调用方不得记失败；
 * 返回非 null = 核验结论（ok=false 时由调用方记 warn + 失败项）。
 * mode="strict"（默认）：像素冻结产物（脸部合成）用，逐像素完全一致；
 * mode="diffusion"：生图/编辑路径用，按面积放宽容差（#1418），避免整幅重绘被系统性误杀。
 */
export async function verifyExpressionFiles(
  basePath: string,
  variantPath: string,
  ellipses?: SpriteEllipse[],
  featherPx: number = SPRITE_MASK_FEATHER_PX_DEFAULT,
  mode: "strict" | "diffusion" = "strict",
): Promise<SpriteVerifyResult | null> {
  const [b, v] = await Promise.all([loadImageRgba(basePath), loadImageRgba(variantPath)]);
  if (!b || !v) return null;
  if (b.width !== v.width || b.height !== v.height) {
    return {
      width: v.width,
      height: v.height,
      ok: false,
      sizeMismatch: true,
      alphaMismatch: 0,
      outsideMismatch: 0,
      diffPixels: 0,
      diffBbox: null,
    };
  }
  const mask = buildAllowedMask(
    b.width,
    b.height,
    ellipses && ellipses.length ? ellipses : [defaultCoarseFaceEllipse(b.width, b.height)],
    featherPx,
  );
  const tolerance = mode === "diffusion" ? diffusionToleranceFor(b.width, b.height) : STRICT_VERIFY_TOLERANCE;
  return verifySpriteImage(b.data, v.data, b.width, b.height, mask, tolerance);
}
