/**
 * Mask 几何与统计工具（移植自「抠图」项目 src/mask.js）。
 */

export interface ContainSize {
  scale: number;
  scaledWidth: number;
  scaledHeight: number;
  offsetX: number;
  offsetY: number;
}

/** 等比缩放使图片完整放入 target×target 画布（letterbox 几何） */
export function containSize(width: number, height: number, target = 1024): ContainSize {
  const scale = Math.min(target / width, target / height);
  const scaledWidth = Math.max(1, Math.round(width * scale));
  const scaledHeight = Math.max(1, Math.round(height * scale));
  return {
    scale,
    scaledWidth,
    scaledHeight,
    offsetX: Math.floor((target - scaledWidth) / 2),
    offsetY: Math.floor((target - scaledHeight) / 2),
  };
}

export interface MaskMetrics {
  coverage: number;
  empty: boolean;
  full: boolean;
}

/** 遮罩覆盖率统计：empty=全透明（识别失败），full=几乎不透明（未抠出） */
export function maskMetrics(alpha: Uint8ClampedArray | Uint8Array | number[]): MaskMetrics {
  if (!alpha.length) return { coverage: 0, empty: true, full: false };
  let foreground = 0;
  for (const value of alpha) if (value >= 128) foreground += 1;
  const coverage = foreground / alpha.length;
  return { coverage, empty: coverage === 0, full: coverage >= 0.98 };
}
