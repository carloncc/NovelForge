/**
 * 边缘去色溢（despill / color decontamination）（移植自「抠图」项目 src/despill.js）。
 *
 * 问题：AI 抠图后边缘像素仍保留原始背景色（如绿幕的绿边），头发、弯折处尤其明显。
 * 原理：假设像素颜色 = 前景色 * α + 背景色 * (1 - α)（unmultiply），
 * 从图像边缘 alpha≈0 的像素估计背景色，再把受污染的像素解回前景色：
 *   fg = (observed - bg * (1 - α)) / α
 * 仅当背景在边缘区域近似均匀时才启用，避免在复杂背景上产生色偏。
 */

const DEFAULT_OPTS = {
  borderPx: 24, // 采样边缘环厚度
  alphaMax: 32, // 只采样 mask alpha 低于该值的像素（视为背景）
  minSamples: 120, // 边缘有效样本数下限，不足则跳过
  maxMAD: 28, // 背景通道中位绝对偏差均值上限，超限视为背景不均匀
  minAlpha: 12, // 低于该 alpha 的像素不参与反解（近乎透明，反解会放大噪声）
  haloRadius: 1, // 色晕环半径：距半透明像素多近算"遮罩边缘"
  haloAlpha: 0.45, // 退化路径（无内部参考）使用的有效 alpha（越小剥离越强）
  haloStrength: 0.85, // Defringe 替换强度（0~1，越高越彻底）
  bgnessDistance: 130, // 判定"颜色接近背景"的距离阈值（RGB 欧氏距离）
  bgnessThreshold: 0.35, // 颜色接近背景的最低程度（1 - dist/bgnessDistance）
};

interface DespillOpts {
  borderPx?: number;
  alphaMax?: number;
  minSamples?: number;
  maxMAD?: number;
  minAlpha?: number;
  haloRadius?: number;
  haloAlpha?: number;
  haloStrength?: number;
  bgnessDistance?: number;
  bgnessThreshold?: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function medianAbsoluteDeviation(values: number[], center: number): number {
  const deviations = values.map((value) => Math.abs(value - center));
  return median(deviations);
}

/**
 * 从图像边缘估计背景色（RGB 中位数），背景不够均匀时返回 null。
 * @param sourceData 源图像 RGBA 像素
 * @param maskAlpha 与源图同尺寸的 mask alpha（长度 width*height）
 */
export function estimateBackgroundColor(
  sourceData: Uint8ClampedArray,
  maskAlpha: Uint8ClampedArray | Uint8Array | number[],
  width: number,
  height: number,
  opts: DespillOpts = {},
): [number, number, number] | null {
  const { borderPx, alphaMax, minSamples, maxMAD } = { ...DEFAULT_OPTS, ...opts };
  if (width < borderPx * 2 || height < borderPx * 2) return null;

  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const pushPixel = (x: number, y: number) => {
    const index = (y * width + x) * 4;
    if (maskAlpha[y * width + x] >= alphaMax) return;
    rs.push(sourceData[index]);
    gs.push(sourceData[index + 1]);
    bs.push(sourceData[index + 2]);
  };

  for (let y = 0; y < height; y += 1) {
    const onTop = y < borderPx;
    const onBottom = y >= height - borderPx;
    if (!onTop && !onBottom) {
      for (let x = 0; x < borderPx; x += 1) pushPixel(x, y);
      for (let x = width - borderPx; x < width; x += 1) pushPixel(x, y);
    } else {
      for (let x = 0; x < width; x += 1) pushPixel(x, y);
    }
  }

  if (rs.length < minSamples) return null;

  const bgR = median(rs);
  const bgG = median(gs);
  const bgB = median(bs);
  const meanMAD = (
    medianAbsoluteDeviation(rs, bgR) +
    medianAbsoluteDeviation(gs, bgG) +
    medianAbsoluteDeviation(bs, bgB)
  ) / 3;
  if (meanMAD > maxMAD) return null;

  return [bgR, bgG, bgB];
}

/**
 * 用 unmultiply 公式去除边缘像素的背景色（含色晕环剥离）。
 * 原地修改 sourceData（RGBA）的 RGB；alpha 通道不受影响。
 */
export function decontaminatePixels(
  sourceData: Uint8ClampedArray,
  maskAlpha: Uint8ClampedArray | Uint8Array | number[],
  width: number,
  height: number,
  bg: [number, number, number],
  opts: DespillOpts = {},
): void {
  const { minAlpha, haloRadius, haloAlpha, haloStrength, bgnessDistance, bgnessThreshold } = { ...DEFAULT_OPTS, ...opts };
  const [bgR, bgG, bgB] = bg;
  const maxHaloDist = bgnessDistance * (1 - bgnessThreshold);
  for (let index = 0; index < maskAlpha.length; index += 1) {
    const alpha = maskAlpha[index];
    if (alpha === 0) {
      // 完全透明的像素颜色设为背景色，避免合成时出现暗晕
      sourceData[index * 4] = bgR;
      sourceData[index * 4 + 1] = bgG;
      sourceData[index * 4 + 2] = bgB;
      continue;
    }
    if (alpha < minAlpha) continue;

    const offset = index * 4;
    if (alpha < 255) {
      const t = alpha / 255;
      const oneMinusT = 1 - t;
      sourceData[offset] = clamp255((sourceData[offset] - bgR * oneMinusT) / t);
      sourceData[offset + 1] = clamp255((sourceData[offset + 1] - bgG * oneMinusT) / t);
      sourceData[offset + 2] = clamp255((sourceData[offset + 2] - bgB * oneMinusT) / t);
      continue;
    }

    // α = 255 的色晕环像素：① 颜色接近背景色 且 ② 紧邻遮罩边缘（邻域存在半透明像素）
    const dr = sourceData[offset] - bgR;
    const dg = sourceData[offset + 1] - bgG;
    const db = sourceData[offset + 2] - bgB;
    const distance = Math.sqrt(dr * dr + dg * dg + db * db);
    if (distance > maxHaloDist) continue;
    const x = index % width;
    const y = (index / width) | 0;
    let nearEdge = false;
    for (let dy = -haloRadius; dy <= haloRadius && !nearEdge; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -haloRadius; dx <= haloRadius; dx += 1) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        if (maskAlpha[ny * width + nx] < 255) { nearEdge = true; break; }
      }
    }
    if (!nearEdge) continue;

    // Defringe：取邻域内前景参考像素（α=255 且颜色远离背景）的平均色替换
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let referenceCount = 0;
    let opaqueCount = 0;
    for (let dy = -haloRadius; dy <= haloRadius; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -haloRadius; dx <= haloRadius; dx += 1) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const neighborIndex = ny * width + nx;
        if (maskAlpha[neighborIndex] < 255) continue;
        opaqueCount += 1;
        const neighborOffset = neighborIndex * 4;
        const ndr = sourceData[neighborOffset] - bgR;
        const ndg = sourceData[neighborOffset + 1] - bgG;
        const ndb = sourceData[neighborOffset + 2] - bgB;
        if (Math.sqrt(ndr * ndr + ndg * ndg + ndb * ndb) <= maxHaloDist) continue;
        sumR += sourceData[neighborOffset];
        sumG += sourceData[neighborOffset + 1];
        sumB += sourceData[neighborOffset + 2];
        referenceCount += 1;
      }
    }
    if (referenceCount > 0) {
      const keep = 1 - haloStrength;
      sourceData[offset] = clamp255(sumR / referenceCount * haloStrength + sourceData[offset] * keep);
      sourceData[offset + 1] = clamp255(sumG / referenceCount * haloStrength + sourceData[offset + 1] * keep);
      sourceData[offset + 2] = clamp255(sumB / referenceCount * haloStrength + sourceData[offset + 2] * keep);
      continue;
    }

    if (opaqueCount >= 4) {
      // 实心区域（如绿色衣服边缘）：没有前景参考说明像素属于同色实体，保持原样
      continue;
    }

    // 极细发丝（不透明邻居少）：退化为按较低有效 alpha 反解
    const t = haloAlpha;
    const oneMinusT = 1 - t;
    sourceData[offset] = clamp255((sourceData[offset] - bgR * oneMinusT) / t);
    sourceData[offset + 1] = clamp255((sourceData[offset + 1] - bgG * oneMinusT) / t);
    sourceData[offset + 2] = clamp255((sourceData[offset + 2] - bgB * oneMinusT) / t);
  }
}

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}
