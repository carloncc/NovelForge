/**
 * 脸部 rig 自动标定（#1085 auto 部分）。
 * 借鉴 TongjiAI4E/VN_Sprite_Expression_Workflow 的 rig.json 结构（MIT，详见 THIRD_PARTY_NOTICES.md），
 * 用现有 vision 通道（chatVision）让模型输出脸部/五官 bbox（归一化坐标），换算为 rig 的 [cx,cy,rx,ry]。
 * rig 缺部件时必须显式报错或回退整张生成，禁止静默降级。
 * 注意：素材页可拖拽椭圆编辑器 UI 不在本轮范围（待办，见总结）。
 */
import type { ApiConfig } from "./types";
import { chatVision, extractJson } from "../api/openaiCompatible";
import { tauri } from "../utils/tauri";
import { log as logger } from "../utils/logger";
import { stableHash } from "./ids";

export const FACE_RIG_FILE = ".novel2vn/face-rig.json";
export const FACE_RIG_VERSION = 1 as const;

/** rig 部件：5 必需 + 2 红晕（embarrassed 类表情需要） */
export type FaceRigPart =
  | "brow_left"
  | "brow_right"
  | "eye_left"
  | "eye_right"
  | "mouth"
  | "blush_left"
  | "blush_right";

export const REQUIRED_RIG_PARTS: FaceRigPart[] = ["brow_left", "brow_right", "eye_left", "eye_right", "mouth"];
export const OPTIONAL_RIG_PARTS: FaceRigPart[] = ["blush_left", "blush_right"];
const ALL_RIG_PARTS: FaceRigPart[] = [...REQUIRED_RIG_PARTS, ...OPTIONAL_RIG_PARTS];

/** rig 椭圆 [cx,cy,rx,ry]：归一化坐标（0..1，相对整图），与分辨率无关 */
export type RigEllipse = [number, number, number, number];
/** 归一化 bbox（vision 模型输出口径） */
export interface NormalizedBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/** 归一化矩形（crop / 肤色采样区，分辨率无关） */
export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceRig {
  version: 1;
  /** base 图指纹（见 fingerprintBaseImage）：base 变了自动重新标定 */
  baseFingerprint: string;
  imageWidth: number;
  imageHeight: number;
  /** 面部裁切（归一化） */
  crop: NormalizedRect;
  /** 五官椭圆选区 [cx,cy,rx,ry]（归一化） */
  parts: Partial<Record<FaceRigPart, RigEllipse>>;
  /** 肤色采样矩形（归一化，默认两颊+下巴+额头，避开五官头发） */
  skinSamples: NormalizedRect[];
  /** 羽化宽度（像素，借鉴源项目的 featherReferencePixels） */
  featherReferencePixels: number;
  /** 头发遮挡（刘海遮眼）：默认不启用 */
  hairMaskEnabled: boolean;
  updatedAt: string;
}

/** bbox 半宽/半高换算椭圆半径的系数（#1085：由 bbox 中心与尺寸推导） */
export const RIG_ELLIPSE_K = 1.0;
/** 默认羽化宽度（像素，1024 级立绘；可在校准文件里手改） */
export const RIG_FEATHER_PX_DEFAULT = 12;
/** 脸部裁切相对脸框的外扩边距（归一化比例） */
export const RIG_CROP_MARGIN = 0.15;

export class FaceRigError extends Error {
  readonly code = "FACE_RIG_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "FaceRigError";
  }
}

function clamp01n(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 校验并归一化单个 bbox（显式报错，不静默吞掉非法值） */
export function normalizeBbox(input: unknown, label: string): NormalizedBbox {
  const r = input as Partial<NormalizedBbox>;
  if (!r || !isFiniteNum(r.x0) || !isFiniteNum(r.y0) || !isFiniteNum(r.x1) || !isFiniteNum(r.y1)) {
    throw new FaceRigError(`脸部 rig 标定结果非法：${label} 不是合法 bbox（需要 x0/y0/x1/y1 归一化数字）`);
  }
  const x0 = clamp01n(r.x0);
  const y0 = clamp01n(r.y0);
  const x1 = clamp01n(r.x1);
  const y1 = clamp01n(r.y1);
  if (!(x1 > x0 && y1 > y0)) {
    throw new FaceRigError(`脸部 rig 标定结果非法：${label} 为空框（x1<=x0 或 y1<=y0）`);
  }
  return { x0, y0, x1, y1 };
}

/** bbox 中心与尺寸推导 rig 椭圆 [cx,cy,rx,ry]（椭圆半径取 bbox 半宽/半高 × 系数） */
export function bboxToEllipse(b: NormalizedBbox, k: number = RIG_ELLIPSE_K): RigEllipse {
  const kk = k > 0 ? k : RIG_ELLIPSE_K;
  return [
    (b.x0 + b.x1) / 2,
    (b.y0 + b.y1) / 2,
    Math.max(0.001, ((b.x1 - b.x0) / 2) * kk),
    Math.max(0.001, ((b.y1 - b.y0) / 2) * kk),
  ];
}

function clampRect(r: NormalizedRect): NormalizedRect {
  const x = clamp01n(r.x);
  const y = clamp01n(r.y);
  const w = Math.max(0, Math.min(1 - x, r.w));
  const h = Math.max(0, Math.min(1 - y, r.h));
  return { x, y, w, h };
}

/**
 * 肤色采样区默认：两颊 + 下巴 + 额头（归一化，避开五官与头发）。
 * 颊部取脸框左右中下，额头取脸框上部，下巴取脸框底部；均为面部大面积肤色区。
 */
export function defaultSkinSamples(face: NormalizedBbox): NormalizedRect[] {
  const fw = face.x1 - face.x0;
  const fh = face.y1 - face.y0;
  const rects: NormalizedRect[] = [
    { x: face.x0 + fw * 0.02, y: face.y0 + fh * 0.45, w: fw * 0.22, h: fh * 0.2 }, // 左颊
    { x: face.x1 - fw * 0.24, y: face.y0 + fh * 0.45, w: fw * 0.22, h: fh * 0.2 }, // 右颊
    { x: face.x0 + fw * 0.3, y: face.y1 - fh * 0.22, w: fw * 0.4, h: fh * 0.16 }, // 下巴
    { x: face.x0 + fw * 0.25, y: face.y0 + fh * 0.04, w: fw * 0.5, h: fh * 0.14 }, // 额头
  ];
  return rects.map(clampRect).filter((r) => r.w > 0.01 && r.h > 0.01);
}

/** 由脸部/五官 bbox 组装完整 rig（含 crop 外扩、默认肤色采样、默认羽化） */
export function rigFromBboxes(
  face: NormalizedBbox,
  parts: Partial<Record<FaceRigPart, NormalizedBbox>>,
  fingerprint: string,
  imageWidth: number,
  imageHeight: number,
): FaceRig {
  const m = RIG_CROP_MARGIN;
  const fw = face.x1 - face.x0;
  const fh = face.y1 - face.y0;
  const crop = clampRect({
    x: face.x0 - fw * m,
    y: face.y0 - fh * m,
    w: fw * (1 + m * 2),
    h: fh * (1 + m * 2),
  });
  const ellipses = Object.fromEntries(
    Object.entries(parts).map(([k, b]) => [k, bboxToEllipse(b as NormalizedBbox)]),
  ) as Partial<Record<FaceRigPart, RigEllipse>>;
  return {
    version: FACE_RIG_VERSION,
    baseFingerprint: fingerprint,
    imageWidth,
    imageHeight,
    crop,
    parts: ellipses,
    skinSamples: defaultSkinSamples(face),
    featherReferencePixels: RIG_FEATHER_PX_DEFAULT,
    hairMaskEnabled: false,
    updatedAt: new Date().toISOString(),
  };
}

/** 解析 vision 标定回复（严格 JSON，显式报错）；未知键忽略，已知部件逐个校验 */
export function parseFaceRigReply(reply: string): {
  face: NormalizedBbox;
  parts: Partial<Record<FaceRigPart, NormalizedBbox>>;
} {
  let data: unknown;
  try {
    data = extractJson(reply);
  } catch {
    throw new FaceRigError("脸部 rig 标定结果非法：vision 回复中没有合法 JSON");
  }
  const r = data as Record<string, unknown>;
  if (!r || typeof r !== "object" || !r.face) {
    throw new FaceRigError("脸部 rig 标定结果非法：缺少 face 脸部框");
  }
  const face = normalizeBbox(r.face, "face");
  const parts: Partial<Record<FaceRigPart, NormalizedBbox>> = {};
  for (const p of ALL_RIG_PARTS) {
    if (r[p] === undefined || r[p] === null) continue;
    parts[p] = normalizeBbox(r[p], p);
  }
  return { face, parts };
}

/** rig 完整性断言：缺 brow/eye/mouth 任一部件直接抛错（不得静默降级） */
export function assertRigComplete(rig: Pick<FaceRig, "parts">): void {
  const missing = REQUIRED_RIG_PARTS.filter((p) => {
    const e = rig.parts[p];
    return !Array.isArray(e) || e.length !== 4 || e.some((v) => typeof v !== "number" || !Number.isFinite(v));
  });
  if (missing.length) {
    throw new FaceRigError(
      `脸部 rig 缺少部件：${missing.join("、")}（不得静默降级：请先脸部校准补齐，或为任务开启 faceCompositeFallback 回退整张生成旧路径）`,
    );
  }
}

/**
 * base 图指纹：尺寸 + 内容采样哈希（首尾各 8k base64 字符 + 总长度）。
 * 全图哈希对 1M+ base64 太贵，采样足以感知 base 更换/重生成。
 */
export function fingerprintBaseImage(dataB64: string, width: number, height: number): string {
  const s = (dataB64 || "").replace(/\s+/g, "");
  return `${width}x${height}:${stableHash(`${s.length}:${s.slice(0, 8192)}:${s.slice(-8192)}`)}`;
}

/** rig 是否需要重新标定：无文件/版本不符/指纹变化/部件不全都要重标 */
export function needsRecalibration(saved: FaceRig | null, fingerprint: string): boolean {
  if (!saved || saved.version !== FACE_RIG_VERSION) return true;
  if (!saved.baseFingerprint || saved.baseFingerprint !== fingerprint) return true;
  try {
    assertRigComplete(saved);
    return false;
  } catch {
    return true;
  }
}

export function rigFilePath(outputDir: string): string {
  return `${outputDir.replace(/[\\/]+$/, "")}/.novel2vn/face-rig.json`;
}

/** 读 rig：文件缺失/解析失败/结构非法一律返回 null（由 ensureFaceRig 决定重标还是显式报错） */
export async function readFaceRig(outputDir: string): Promise<FaceRig | null> {
  try {
    const path = rigFilePath(outputDir);
    if (!(await tauri.pathExists(path).catch(() => false))) return null;
    const { text } = await tauri.readTextFile(path);
    const r = JSON.parse(text) as Partial<FaceRig>;
    if (!r || r.version !== FACE_RIG_VERSION || !r.crop || !r.parts) return null;
    return r as FaceRig;
  } catch (e) {
    logger.warn("faceRig", "脸部 rig 文件读取/解析失败（将重新标定或显式报错）", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** 写 rig（供自动标定与后续手动校准编辑器复用同一文件） */
export async function writeFaceRig(outputDir: string, rig: FaceRig): Promise<void> {
  const dir = `${outputDir.replace(/[\\/]+$/, "")}/.novel2vn`;
  await tauri.mkdirAll(dir);
  await tauri.writeTextFile(rigFilePath(outputDir), JSON.stringify(rig, null, 2));
}

const RIG_VISION_SYSTEM = `你是立绘脸部标定器。用户给你一张动漫角色立绘（全身像、纯色背景），请输出脸部与五官的位置。
只输出严格 JSON（不要 markdown 代码块，不要其他文字），坐标全部是相对整图的归一化坐标（0..1，原点左上角）：
{
  "face": {"x0": 0.0, "y0": 0.0, "x1": 1.0, "y1": 1.0},
  "brow_left": {"x0": 0, "y0": 0, "x1": 0, "y1": 0},
  "brow_right": {"x0": 0, "y0": 0, "x1": 0, "y1": 0},
  "eye_left": {"x0": 0, "y0": 0, "x1": 0, "y1": 0},
  "eye_right": {"x0": 0, "y0": 0, "x1": 0, "y1": 0},
  "mouth": {"x0": 0, "y0": 0, "x1": 0, "y1": 0}
}
要求：
1. face 是完整脸部外框（含下巴与发际线内侧，不含大面积头发）；
2. 画面左侧是角色的右眼/右眉（即 brow_left/eye_left 取画面左侧）；每个框紧贴对应五官；
3. 框必须在脸部内部且 x1>x0、y1>y0；看不清的部件也必须给最合理的估计框，绝不省略键（省略会导致整条链路显式失败）。`;

/** 用 vision 通道标定单张 base 立绘（缺部件直接抛错，不静默降级） */
export async function calibrateFaceRig(
  visionCfg: ApiConfig,
  baseB64: string,
  imageWidth: number,
  imageHeight: number,
): Promise<FaceRig> {
  const reply = await chatVision(
    visionCfg,
    RIG_VISION_SYSTEM,
    "请标定这张立绘的脸部与五官 bbox（归一化坐标，只输出 JSON）。",
    baseB64,
    { maxTokens: 800, temperature: 0 },
  );
  const { face, parts } = parseFaceRigReply(reply);
  const rig = rigFromBboxes(face, parts, fingerprintBaseImage(baseB64, imageWidth, imageHeight), imageWidth, imageHeight);
  assertRigComplete(rig);
  return rig;
}

export interface EnsureFaceRigOptions {
  outputDir: string;
  baseB64: string;
  width: number;
  height: number;
  /** vision 配置：缺失时无法自动标定，只能显式报错（或由调用方回退整张生成） */
  visionCfg?: ApiConfig;
  /** false = 禁止自动标定（只读现有 rig，不可用直接抛错） */
  autoCalibrate?: boolean;
}

/**
 * 取可用 rig：现有 rig 指纹命中且部件齐全直接复用；否则自动重标并写盘。
 * 无法自动标定（无 vision 通道）时显式抛错，禁止静默降级为整张生成。
 */
export async function ensureFaceRig(opts: EnsureFaceRigOptions): Promise<{ rig: FaceRig; recalibrated: boolean }> {
  const fp = fingerprintBaseImage(opts.baseB64, opts.width, opts.height);
  const saved = await readFaceRig(opts.outputDir);
  if (saved && !needsRecalibration(saved, fp)) {
    return { rig: saved, recalibrated: false };
  }
  if (opts.autoCalibrate !== false && opts.visionCfg?.apiKey) {
    const rig = await calibrateFaceRig(opts.visionCfg, opts.baseB64, opts.width, opts.height);
    await writeFaceRig(opts.outputDir, rig);
    logger.info("faceRig", `脸部 rig 已${saved ? "重新" : ""}标定`, { recalibrated: !!saved });
    return { rig, recalibrated: true };
  }
  throw new FaceRigError(
    `脸部 rig ${!saved ? "缺失" : "已过期/部件不全"}且无法自动标定（未配置可用的 vision 通道）。不得静默降级：请先完成脸部校准（可拖拽椭圆编辑器为待办），或为任务开启 faceCompositeFallback 回退整张生成旧路径。`,
  );
}

/* ================= 归一化 rig → 像素坐标（合成/核验用） ================= */

export interface PixelEllipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rigEllipseToPixels(e: RigEllipse, width: number, height: number): PixelEllipse {
  return { cx: e[0] * width, cy: e[1] * height, rx: Math.max(1, e[2] * width), ry: Math.max(1, e[3] * height) };
}

export function rigRectToPixels(r: NormalizedRect, width: number, height: number): PixelRect {
  return { x: r.x * width, y: r.y * height, w: Math.max(1, r.w * width), h: Math.max(1, r.h * height) };
}
