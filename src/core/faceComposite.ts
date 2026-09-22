/**
 * 局部脸部重绘 + 合成器（#1086，默认关闭的可选项）。
 * 算法与参数参考 TongjiAI4E/VN_Sprite_Expression_Workflow（MIT），详见仓库根 THIRD_PARTY_NOTICES.md：
 * 按 rig.crop 裁脸 → 复用 editImageVariant 对脸部做表情编辑 → 按仓库算法合成回原图
 * （clean 清理旧五官、brow/mouth 取 dark、eye 取 max(dark,light)、软阈值 (delta-7)/24、
 * 椭圆×1.08+羽化、肤色通道中位差对齐、alpha 与允许区外像素冻结）。
 * 合成后必须过 #1084 核验（spriteVerify），失败显式抛错进失败项；禁止静默降级。
 * canvas 拼装部分仅在浏览器/Tauri（含 DOM）环境运行；像素数学均为纯函数（可单测）。
 */
import type { ApiConfig, ImageTask, PipelineEvent } from "./types";
import { editImageVariant, supportsImageEdits } from "../api/imageEdits";
import { tauri } from "../utils/tauri";
import { imageMimeForPath } from "../utils/mime";
import { log as logger } from "../utils/logger";
import {
  assertRigComplete,
  ensureFaceRig,
  rigEllipseToPixels,
  rigRectToPixels,
  type FaceRig,
  type FaceRigPart,
} from "./faceRig";
import { buildAllowedMask, verifySpriteImage, type SpriteEllipse } from "./spriteVerify";

/* ================= 纯函数：笔触/肤色/头发数学（#1087 附录常量） ================= */

/** 软阈值下限/区间：strength = clamp((delta - 7) / 24, 0, 1) */
export const STROKE_SOFT_MIN = 7;
export const STROKE_SOFT_RANGE = 24;
/** 红晕叠加强度 */
export const BLUSH_STRENGTH = 0.5;
/** 肤色采样跳过高饱和像素的阈值（max-min > 55） */
export const SKIN_SAT_SKIP = 55;
/** 脸部编辑参考尺寸（长边，像素） */
export const FACE_EDIT_LONG_SIDE = 1024;

/** 笔触提取模式：brow/mouth 只用变暗 dark，eye 用 max(dark,light)，红晕走 blush */
export type StrokeMode = "dark" | "max" | "blush";

export function partStrokeMode(part: FaceRigPart): StrokeMode {
  if (part === "blush_left" || part === "blush_right") return "blush";
  if (part === "eye_left" || part === "eye_right") return "max";
  return "dark";
}

export function clamp01fc(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

function clamp255(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

/** 笔触强度软阈值（#1087）：strength = clamp((delta - 7) / 24, 0, 1) */
export function strokeStrength(delta: number): number {
  return clamp01fc((delta - STROKE_SOFT_MIN) / STROKE_SOFT_RANGE);
}

export type Rgb = [number, number, number];

/** 通道差：dark = max(clean_i - cand_i)，light = max(cand_i - clean_i)，钳到 >= 0 */
export function strokeDeltas(clean: Rgb, cand: Rgb): { dark: number; light: number } {
  let dark = 0;
  let light = 0;
  for (let i = 0; i < 3; i++) {
    const d = clean[i] - cand[i];
    if (d > dark) dark = d;
    if (-d > light) light = -d;
  }
  return { dark, light };
}

/** 红晕条件（#1087）：仅当 cand_r > cand_g + 5 && cand_g >= cand_b - 4 时叠加 */
export function blushActive(r: number, g: number, b: number): boolean {
  return r > g + 5 && g >= b - 4;
}

/**
 * 头发遮挡（#1087，可选自动）：yellow = clamp((r - b - 25)/28)，
 * warm = clamp((g - b - 12)/20)，hairMask = yellow * warm。
 * 眼球区域乘 (1 - hairMask) 解决刘海穿眼；不影响眉毛（调用方只对 eye 模式传入）。
 */
export function hairMaskValue(r: number, g: number, b: number): number {
  return clamp01fc((r - b - 25) / 28) * clamp01fc((g - b - 12) / 20);
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 肤色通道中位差对齐（#1087）：采样区跳过高饱和像素（max-min > 55，clean/cand 任一端超标即跳过该对），
 * 取各通道差值（clean - cand）的中位数作为偏移量；无有效样本返回 [0,0,0]。
 */
export function skinMedianOffset(cleanSamples: Rgb[], candSamples: Rgb[]): Rgb {
  const n = Math.min(cleanSamples.length, candSamples.length);
  const diffs: number[][] = [[], [], []];
  for (let i = 0; i < n; i++) {
    const a = cleanSamples[i];
    const b = candSamples[i];
    if (Math.max(...a) - Math.min(...a) > SKIN_SAT_SKIP) continue;
    if (Math.max(...b) - Math.min(...b) > SKIN_SAT_SKIP) continue;
    for (let c = 0; c < 3; c++) diffs[c].push(a[c] - b[c]);
  }
  return [median(diffs[0]), median(diffs[1]), median(diffs[2])].map((v) => Math.round(v)) as Rgb;
}

export interface CompositePixelOptions {
  /** 该像素的允许区掩膜值（0..1，已含椭圆×1.08+羽化） */
  mask: number;
  mode: StrokeMode;
  /** 肤色通道中位差（clean - cand） */
  skinOffset: Rgb;
  /** 该像素的头发遮挡值（0..1，仅 eye/max 模式使用） */
  hairCover: number;
}

/**
 * 单像素合成（纯函数）：alpha 由调用方冻结（只返回 RGB）。
 * out = base * (1 - t) + (cand + skinOffset) * t，t = mask * strength（eye 再乘 (1 - hairCover)，blush 固定 ×0.5）。
 */
export function compositeFacePixel(base: Rgb, clean: Rgb, cand: Rgb, opts: CompositePixelOptions): Rgb {
  const { dark, light } = strokeDeltas(clean, cand);
  let t: number;
  if (opts.mode === "blush") {
    if (!blushActive(cand[0], cand[1], cand[2])) return [...base] as Rgb;
    t = opts.mask * strokeStrength(Math.max(dark, light)) * BLUSH_STRENGTH;
  } else {
    const delta = opts.mode === "max" ? Math.max(dark, light) : dark;
    const strength = strokeStrength(delta);
    if (strength <= 0 || opts.mask <= 0) return [...base] as Rgb;
    t = opts.mask * strength;
    if (opts.mode === "max") t *= 1 - clamp01fc(opts.hairCover);
  }
  if (t <= 0) return [...base] as Rgb;
  const tt = Math.min(1, t);
  return [
    clamp255(base[0] * (1 - tt) + clamp255(cand[0] + opts.skinOffset[0]) * tt),
    clamp255(base[1] * (1 - tt) + clamp255(cand[1] + opts.skinOffset[1]) * tt),
    clamp255(base[2] * (1 - tt) + clamp255(cand[2] + opts.skinOffset[2]) * tt),
  ];
}

/* ================= 错误类型（显式失败，禁止静默降级） ================= */

export class FaceCompositeError extends Error {
  readonly code = "FACE_COMPOSITE_FAILED" as const;
  constructor(message: string) {
    super(message);
    this.name = "FaceCompositeError";
  }
}

/* ================= DOM 拼装（浏览器/Tauri 环境，Node 下抛错走回退/失败项） ================= */

function requireDom(): void {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    throw new FaceCompositeError("脸部合成需要 DOM canvas 环境（Node/单测环境不可用；请走整张生成旧路径）");
  }
}

function loadHtmlImage(dataUrl: string): Promise<HTMLImageElement> {
  requireDom();
  return new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new FaceCompositeError("脸部合成：base 图解码失败（文件可能损坏）"));
    el.src = dataUrl;
  });
}

function canvasOf(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new FaceCompositeError("脸部合成：canvas 2d 上下文不可用");
  return { canvas, ctx };
}

function canvasToB64(canvas: HTMLCanvasElement): string {
  const b64 = canvas.toDataURL("image/png").split(",")[1] ?? "";
  if (!b64) throw new FaceCompositeError("脸部合成：canvas 编码 PNG 失败");
  return b64;
}

export interface FaceCompositeIo {
  /** 合成后的整图 PNG（base64，不含 data URL 前缀；alpha 与允许区外像素与 base 逐像素一致） */
  dataB64: string;
  /** 本次肤色通道中位差（诊断用） */
  skinOffset: Rgb;
}

/**
 * 脸部合成主流程（DOM）：base 全图 + rig → 裁脸 → editImageVariant 表情编辑 → 合成回原图 → #1084 核验。
 * 核验失败直接抛错（由调用方记失败项，或按 faceCompositeFallback 回退整张生成）。
 */
export async function compositeExpressionFace(opts: {
  baseB64: string;
  baseMime?: string;
  rig: FaceRig;
  imageCfg: ApiConfig;
  faceEditPrompt: string;
}): Promise<FaceCompositeIo> {
  requireDom();
  assertRigComplete(opts.rig);
  if (!supportsImageEdits(opts.imageCfg.model)) {
    throw new FaceCompositeError(
      `脸部合成需要图像编辑端点（GPT-Image 系），当前模型 ${opts.imageCfg.model || "（未设置）"} 不支持；请换模型或为任务开启 faceCompositeFallback 回退整张生成`,
    );
  }
  const mime = opts.baseMime || "image/png";
  const baseImg = await loadHtmlImage(`data:${mime};base64,${opts.baseB64}`);
  const W = baseImg.naturalWidth || baseImg.width;
  const H = baseImg.naturalHeight || baseImg.height;
  if (!W || !H) throw new FaceCompositeError("脸部合成：base 图尺寸非法");

  // base 全图 RGBA（clean 脸 = base 脸本身：normal 底图的脸即净脸）
  const baseCv = canvasOf(W, H);
  baseCv.ctx.drawImage(baseImg, 0, 0);
  const baseData = baseCv.ctx.getImageData(0, 0, W, H);

  // 按 rig.crop 裁脸并缩放到参考尺寸（长边 FACE_EDIT_LONG_SIDE）
  const cropPx = rigRectToPixels(opts.rig.crop, W, H);
  const longSide = Math.max(cropPx.w, cropPx.h);
  const editScale = longSide > 0 ? FACE_EDIT_LONG_SIDE / longSide : 1;
  const editW = Math.max(1, Math.round(cropPx.w * editScale));
  const editH = Math.max(1, Math.round(cropPx.h * editScale));
  const cropCv = canvasOf(cropPx.w, cropPx.h);
  cropCv.ctx.drawImage(baseCv.canvas, cropPx.x, cropPx.y, cropPx.w, cropPx.h, 0, 0, cropCv.canvas.width, cropCv.canvas.height);
  const editCv = canvasOf(editW, editH);
  editCv.ctx.drawImage(cropCv.canvas, 0, 0, editW, editH);

  // 脸部表情编辑（只改表情的候选脸）
  const edited = await editImageVariant(opts.imageCfg, {
    prompt: opts.faceEditPrompt,
    imageB64: canvasToB64(editCv.canvas),
    imageMime: "image/png",
    width: editW,
    height: editH,
  });
  const candImg = await loadHtmlImage(`data:${edited.mime};base64,${edited.dataB64}`);
  // 候选脸重采样回裁切分辨率（与 clean 对齐做笔触提取）
  const candCv = canvasOf(cropCv.canvas.width, cropCv.canvas.height);
  candCv.ctx.drawImage(candImg, 0, 0, candCv.canvas.width, candCv.canvas.height);
  const cleanData = cropCv.ctx.getImageData(0, 0, cropCv.canvas.width, cropCv.canvas.height);
  const candData = candCv.ctx.getImageData(0, 0, candCv.canvas.width, candCv.canvas.height);

  // 肤色中位差：采样区映射到裁切坐标系，clean/cand 配对采样
  const toCrop = (px: number, py: number): { x: number; y: number } => ({
    x: ((px - cropPx.x) / cropPx.w) * cleanData.width,
    y: ((py - cropPx.y) / cropPx.h) * cleanData.height,
  });
  const cleanSkin: Rgb[] = [];
  const candSkin: Rgb[] = [];
  for (const s of opts.rig.skinSamples) {
    const r = rigRectToPixels(s, W, H);
    const x0 = Math.max(0, Math.floor(toCrop(r.x, r.y).x));
    const y0 = Math.max(0, Math.floor(toCrop(r.x, r.y).y));
    const x1 = Math.min(cleanData.width - 1, Math.ceil(toCrop(r.x + r.w, r.y + r.h).x));
    const y1 = Math.min(cleanData.height - 1, Math.ceil(toCrop(r.x + r.w, r.y + r.h).y));
    for (let y = y0; y <= y1; y += 2) {
      for (let x = x0; x <= x1; x += 2) {
        const o = (y * cleanData.width + x) * 4;
        cleanSkin.push([cleanData.data[o], cleanData.data[o + 1], cleanData.data[o + 2]]);
        candSkin.push([candData.data[o], candData.data[o + 1], candData.data[o + 2]]);
      }
    }
  }
  const skinOffset = skinMedianOffset(cleanSkin, candSkin);

  // 部件椭圆（整图像素坐标）→ 允许区掩膜（与 #1084 同公式，供合成与核验共用）
  const partEllipses = (Object.entries(opts.rig.parts) as [FaceRigPart, [number, number, number, number]][])
    .filter(([, e]) => Array.isArray(e) && e.length === 4)
    .map(([part, e]) => ({ part, e: rigEllipseToPixels(e, W, H) }));
  const mask = buildAllowedMask(
    W,
    H,
    partEllipses.map((p) => p.e as SpriteEllipse),
    opts.rig.featherReferencePixels,
  );

  // 逐像素合成（只写裁切区；区外与 alpha 保持 base 原样=冻结）
  const out = baseCv.ctx.createImageData(W, H);
  out.data.set(baseData.data);
  const cx0 = Math.max(0, Math.floor(cropPx.x));
  const cy0 = Math.max(0, Math.floor(cropPx.y));
  const cx1 = Math.min(W - 1, Math.ceil(cropPx.x + cropPx.w));
  const cy1 = Math.min(H - 1, Math.ceil(cropPx.y + cropPx.h));
  for (let y = cy0; y <= cy1; y++) {
    for (let x = cx0; x <= cx1; x++) {
      const mi = y * W + x;
      const m = mask[mi];
      if (m <= 0) continue;
      // 取 mask 最大的部件及其笔触模式（清理区与提取区分离：旧五官清理靠 clean 恢复+新笔触叠加）
      let bestMode: StrokeMode = "dark";
      let bestM = -1;
      for (const p of partEllipses) {
        // 各部件掩膜在此像素的值（复用同一羽化公式，逐部件计算）
        const { part, e } = p;
        const rx = Math.max(1, e.rx * 1.08);
        const ry = Math.max(1, e.ry * 1.08);
        const q = Math.hypot((x - e.cx) / rx, (y - e.cy) / ry);
        const feather = opts.rig.featherReferencePixels > 0 ? opts.rig.featherReferencePixels : 12;
        const pm = Math.max(0, Math.min(1, ((1 - q) * Math.min(rx, ry)) / feather));
        if (pm > bestM) {
          bestM = pm;
          bestMode = partStrokeMode(part);
        }
      }
      const o = mi * 4;
      const base: Rgb = [baseData.data[o], baseData.data[o + 1], baseData.data[o + 2]];
      const lx = Math.min(cleanData.width - 1, Math.max(0, Math.round(toCrop(x, y).x)));
      const ly = Math.min(cleanData.height - 1, Math.max(0, Math.round(toCrop(x, y).y)));
      const co = (ly * cleanData.width + lx) * 4;
      const clean: Rgb = [cleanData.data[co], cleanData.data[co + 1], cleanData.data[co + 2]];
      const cand: Rgb = [candData.data[co], candData.data[co + 1], candData.data[co + 2]];
      const hairCover = opts.rig.hairMaskEnabled && bestMode === "max" ? hairMaskValue(base[0], base[1], base[2]) : 0;
      const px = compositeFacePixel(base, clean, cand, { mask: m, mode: bestMode, skinOffset, hairCover });
      out.data[o] = px[0];
      out.data[o + 1] = px[1];
      out.data[o + 2] = px[2];
      // alpha 冻结：out.data[o + 3] 保持 base（createImageData 后已 set 全量 base，含 alpha）
    }
  }

  // 合成后必须过 #1084 核验（允许区外 RGBA + 整幅 alpha 逐像素一致），失败显式抛错
  const vr = verifySpriteImage(baseData.data, out.data, W, H, mask);
  if (!vr.ok) {
    const box = vr.diffBbox ? `bbox(${vr.diffBbox.x0},${vr.diffBbox.y0})-(${vr.diffBbox.x1},${vr.diffBbox.y1})` : "无bbox";
    throw new FaceCompositeError(
      `脸部合成核验未通过（允许区外差异 ${vr.outsideMismatch} 像素，alpha 差异 ${vr.alphaMismatch} 像素，${box}），已记失败项；可重试或开启 faceCompositeFallback 回退整张生成`,
    );
  }

  const outCv = canvasOf(W, H);
  outCv.ctx.putImageData(out, 0, 0);
  return { dataB64: canvasToB64(outCv.canvas), skinOffset };
}

export interface RunFaceCompositeTaskOptions {
  task: ImageTask;
  /** base（normal 立绘）产物路径：缺失直接显式报错，不静默降级 */
  basePath?: string;
  /** 项目输出目录（rig 读写 .novel2vn/face-rig.json） */
  outputDir: string;
  imageCfg: ApiConfig;
  visionCfg?: ApiConfig;
  /** 脸部表情编辑指令（调用方传入 expressionEditPrompt(task)，避免 core 循环依赖） */
  faceEditPrompt: string;
  log?: (ev: PipelineEvent) => void;
}

/**
 * 表情差分任务的脸部合成入口（images.ts 调用）：
 * base 图 → ensureFaceRig（自动标定/过期重标；不可用显式报错）→ compositeExpressionFace（含核验）。
 */
export async function runFaceCompositeTask(opts: RunFaceCompositeTaskOptions): Promise<FaceCompositeIo> {
  if (!opts.basePath) {
    throw new FaceCompositeError(
      `脸部合成缺少 base 参考图（任务 ${opts.task.id} 无 refFromTask 对应产物；不得静默降级，请先生成 normal 立绘或开启 faceCompositeFallback）`,
    );
  }
  if (!(await tauri.pathExists(opts.basePath).catch(() => false))) {
    throw new FaceCompositeError(`脸部合成的 base 参考图缺失：${opts.basePath}（任务 ${opts.task.id}；请先生成 normal 立绘）`);
  }
  const baseB64 = await tauri.readFileBase64(opts.basePath);
  if (!baseB64 || !baseB64.trim()) {
    throw new FaceCompositeError(`脸部合成的 base 参考图为空：${opts.basePath}（任务 ${opts.task.id}）`);
  }
  // base 尺寸（指纹需要；DOM 不可用时 compositeExpressionFace 会再抛明确错误）
  let width = 0;
  let height = 0;
  try {
    requireDom();
    const probe = await loadHtmlImage(`data:${imageMimeForPath(opts.basePath)};base64,${baseB64}`);
    width = probe.naturalWidth || probe.width;
    height = probe.naturalHeight || probe.height;
  } catch (e) {
    if (e instanceof FaceCompositeError) throw e;
    throw new FaceCompositeError(`脸部合成：base 图解码失败（${opts.basePath}）：${e instanceof Error ? e.message : String(e)}`);
  }
  const { rig, recalibrated } = await ensureFaceRig({
    outputDir: opts.outputDir,
    baseB64,
    width,
    height,
    visionCfg: opts.visionCfg,
  });
  opts.log?.({
    step: "图像",
    message: recalibrated ? `脸部 rig 已重新标定：${opts.task.usage ?? opts.task.id}` : `脸部 rig 复用：${opts.task.usage ?? opts.task.id}`,
    level: "info",
    at: Date.now(),
  });
  logger.info("faceComposite", "开始脸部合成", { id: opts.task.id, recalibrated });
  return compositeExpressionFace({
    baseB64,
    baseMime: imageMimeForPath(opts.basePath),
    rig,
    imageCfg: opts.imageCfg,
    faceEditPrompt: opts.faceEditPrompt,
  });
}
