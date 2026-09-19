/**
 * 主题取色：从画风参考图/背景图提取 2 个主色，用于生成每部作品自己的界面主题。
 * 纯函数部分（pickAccentColorsFromPixels）不依赖 DOM，便于单测；抽图部分在无 DOM 环境自动跳过。
 */

export interface AccentColor {
  h: number;
  s: number;
  l: number;
}

export interface AccentPair {
  accent: AccentColor;
  accent2: AccentColor;
}

export function hslOf(c: AccentColor, alpha?: number): string {
  const s = Math.round(c.s);
  const l = Math.round(c.l);
  return alpha === undefined ? `hsl(${Math.round(c.h)}, ${s}%, ${l}%)` : `hsla(${Math.round(c.h)}, ${s}%, ${l}%, ${alpha})`;
}

/**
 * 从 RGBA 像素中挑主色：跳过透明/近黑近白/低饱和像素，按色相分桶加权（权重=饱和度×中亮度偏好），
 * 取权重最高的桶为强调色、与其色相相距 ≥60° 的次高桶为副色。样本不足返回 null。
 */
export function pickAccentColorsFromPixels(data: Uint8ClampedArray): AccentPair | null {
  const BUCKETS = 12;
  const weight = new Array<number>(BUCKETS).fill(0);
  const hueSum = new Array<number>(BUCKETS).fill(0);
  const satSum = new Array<number>(BUCKETS).fill(0);
  const litSum = new Array<number>(BUCKETS).fill(0);
  const count = new Array<number>(BUCKETS).fill(0);
  let total = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 200) continue;
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (l > 0.9 || l < 0.12) continue;
    const d = max - min;
    if (d < 1e-6) continue;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (s < 0.22) continue;
    let h = 0;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
    const bucket = Math.min(BUCKETS - 1, Math.floor(h / (360 / BUCKETS)));
    const w = s * (1 - Math.abs(l - 0.55));
    weight[bucket] += w;
    hueSum[bucket] += h;
    satSum[bucket] += s;
    litSum[bucket] += l;
    count[bucket]++;
    total++;
  }
  if (total < 24) return null;
  const ranked = weight
    .map((w, i) => ({ w, i }))
    .filter((x) => count[x.i] >= 8)
    .sort((a, b) => b.w - a.w);
  if (!ranked.length) return null;
  const toColor = (i: number): AccentColor => ({
    h: hueSum[i] / count[i],
    s: Math.max(45, Math.min(80, (satSum[i] / count[i]) * 100)),
    l: Math.max(52, Math.min(70, (litSum[i] / count[i]) * 100)),
  });
  const accent = toColor(ranked[0].i);
  const second = ranked.find((x) => hueDistance(toColor(x.i).h, accent.h) >= 60);
  const accent2 = second ? toColor(second.i) : { ...accent, h: (accent.h + 28) % 360, l: Math.min(74, accent.l + 8) };
  return { accent, accent2 };
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** 从图片文件提取主色（需要 DOM canvas 环境；失败/无 DOM 返回 null，调用方用默认紫罗兰主题） */
export async function extractAccentFromImage(
  path: string,
  readBase64: (p: string) => Promise<string>,
): Promise<AccentPair | null> {
  if (typeof document === "undefined") return null;
  try {
    const b64 = await readBase64(path);
    if (!b64) return null;
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => resolve(null);
      el.src = b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
    });
    if (!img || !img.naturalWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 32, 32);
    return pickAccentColorsFromPixels(ctx.getImageData(0, 0, 32, 32).data);
  } catch {
    return null;
  }
}
