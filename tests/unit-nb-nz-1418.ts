/**
 * #1418 表情差分核验口径：严格 vs 扩散容差。
 * 背景：生图/编辑路径是整幅扩散重绘 + 抠图，允许区外必然有噪声；旧实现用严格逐像素核验所有差分
 * → 系统性误杀 → 删已付费图片 → 重试再失败的死循环。本测试锁定容差语义与退化为严格的行为。
 */
import {
  DIFFUSION_CHANNEL_TOLERANCE,
  DIFFUSION_DIFF_RATIO,
  STRICT_VERIFY_TOLERANCE,
  diffusionToleranceFor,
  verifySpriteImage,
} from "../src/core/spriteVerify";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function solid(w: number, h: number, rgba: [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set(rgba, i * 4);
  return out;
}

/* ---------- 1) 严格口径常量与默认行为（缺省=严格，向后兼容） ---------- */
assert(
  STRICT_VERIFY_TOLERANCE.channelTolerance === 0
    && STRICT_VERIFY_TOLERANCE.maxOutsideMismatch === 0
    && STRICT_VERIFY_TOLERANCE.maxAlphaMismatch === 0,
  "严格口径三项必须为 0",
);

{
  const w = 8;
  const h = 8;
  const base = solid(w, h, [200, 150, 120, 255]);
  const variant = solid(w, h, [200, 150, 120, 255]);
  variant[(3 * w + 5) * 4] = 10; // 区外单点微噪声
  const mask = new Float32Array(w * h); // 全区外
  const strict = verifySpriteImage(base, variant, w, h, mask); // 缺省严格
  assert(!strict.ok && strict.outsideMismatch === 1, "缺省严格口径应抓出区外任何差异");
}

/* ---------- 2) 扩散容差：同样的小噪声应通过 ---------- */
{
  const w = 32;
  const h = 32;
  const base = solid(w, h, [200, 150, 120, 255]);
  const variant = solid(w, h, [200, 150, 120, 255]);
  // 区外散布 100 个点，每通道改动 12（<= channelTolerance 16）
  let changed = 0;
  for (let i = 0; i < 100; i++) {
    const o = i * 4;
    variant[o] = 200 - 12;
    variant[o + 1] = 150 + 12;
    variant[o + 2] = 120 - 12;
    changed++;
  }
  const mask = new Float32Array(w * h);
  const tol = diffusionToleranceFor(w, h);
  const r = verifySpriteImage(base, variant, w, h, mask, tol);
  assert(changed === 100, "sanity");
  assert(r.ok && r.outsideMismatch === 0, "容差内噪声不应计失败（每通道 <= 16）");
}

/* ---------- 3) 扩散容差：超过每通道阈值仍计差异，且总量超上限判失败 ---------- */
{
  const w = 32;
  const h = 32;
  const base = solid(w, h, [200, 150, 120, 255]);
  const variant = solid(w, h, [200, 150, 120, 255]);
  // 让所有区外像素每通道偏 40（> 16）：总量远超面积 2% 上限 → 失败
  for (let i = 0; i < w * h; i++) {
    variant[i * 4] = 200 - 40;
  }
  const mask = new Float32Array(w * h);
  const r = verifySpriteImage(base, variant, w, h, mask, diffusionToleranceFor(w, h));
  assert(!r.ok && r.outsideMismatch === w * h, "整幅漂移应判失败（身体/衣物整体错位）");
}

/* ---------- 4) 差异像素上限按面积 2% 缩放 ---------- */
{
  const tol = diffusionToleranceFor(100, 100);
  assert(tol.channelTolerance === DIFFUSION_CHANNEL_TOLERANCE, "通道容差应取扩散常量");
  assert(tol.maxOutsideMismatch === Math.ceil(10000 * DIFFUSION_DIFF_RATIO), "区外上限应=面积×2%");
  assert(tol.maxAlphaMismatch === tol.maxOutsideMismatch, "alpha 上限应=区外上限");
  assert(diffusionToleranceFor(0, 0).maxOutsideMismatch === 0, "空画布上限应为 0");
}

/* ---------- 5) alpha 容差：小幅 alpha 差异在扩散口径下通过，超出仍抓 ---------- */
{
  const w = 16;
  const h = 16;
  const base = solid(w, h, [200, 150, 120, 255]);
  const small = solid(w, h, [200, 150, 120, 255]);
  small[3] = 255 - 8; // 单个像素 alpha -8（<=16）
  const mask = new Float32Array(w * h);
  const rSmall = verifySpriteImage(base, small, w, h, mask, diffusionToleranceFor(w, h));
  assert(rSmall.ok && rSmall.alphaMismatch === 0, "alpha 容差内不应计失败");

  const big = solid(w, h, [200, 150, 120, 255]);
  for (let i = 0; i < w * h; i++) big[i * 4 + 3] = 0; // 整幅 alpha 0
  const rBig = verifySpriteImage(base, big, w, h, mask, diffusionToleranceFor(w, h));
  assert(!rBig.ok && rBig.alphaMismatch === w * h, "整幅 alpha 变化必须抓出");
}

/* ---------- 6) 尺寸不一致在容差口径下仍是硬失败（sizeMismatch） ---------- */
{
  const tol = diffusionToleranceFor(10, 10);
  const r = verifySpriteImage(new Uint8Array(4), new Uint8Array(8), 1, 1, new Float32Array(1), tol);
  assert(!r.ok && r.sizeMismatch, "长度不符应判尺寸不一致");
}

console.log("=== #1418 sprite verify tolerance tests passed ===");
