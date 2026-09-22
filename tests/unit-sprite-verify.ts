/**
 * #1084 差分核验器纯函数单测（像素数学必须可测；canvas 拼装除外）。
 * 覆盖：椭圆掩膜（扩大 1.08 + 羽化）、允许区并集、逐像素校验、bbox、任务判定与失败文案。
 */
import {
  buildAllowedMask,
  defaultCoarseFaceEllipse,
  ellipseMaskAt,
  formatSpriteVerifyFailure,
  isExpressionDiffTask,
  SPRITE_MASK_EXPAND,
  verifySpriteImage,
} from "../src/core/spriteVerify";
import type { ImageTask } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

/* ---------- 1) 椭圆掩膜：中心为 1，远处为 0，扩大系数生效 ---------- */
const e = { cx: 10, cy: 10, rx: 10, ry: 10 };
// 中心值 = min(rx,ry)*1.08/feather（羽化公式），此处为 10.8/12 = 0.9；小 feather 时钳到 1
assert(approx(ellipseMaskAt(10, 10, e, 12), 0.9), "椭圆中心掩膜应为 min(rx,ry)*1.08/feather");
assert(ellipseMaskAt(10, 10, e, 2) === 1, "小羽化时中心应钳到 1");
// 紧贴原半径边缘（q≈1/1.08<1）：扩大后仍在允许区内
const edgeInside = ellipseMaskAt(10 + 10, 10, e, 12);
assert(edgeInside > 0 && edgeInside < 1, `原半径边缘应落入羽化带，实际 ${edgeInside}`);
// 远点为 0
assert(ellipseMaskAt(100, 100, e, 12) === 0, "远点掩膜应为 0");
// feather 越大过渡带越宽：同一羽化带点的值越小（公式 mask=((1-q)*min(r))/feather）
assert(
  ellipseMaskAt(15, 10, e, 6) > ellipseMaskAt(15, 10, e, 24),
  "feather 越大同一点掩膜值应越小（过渡带更宽）",
);
assert(SPRITE_MASK_EXPAND === 1.08, "扩大系数必须为借鉴源的 1.08");

/* ---------- 2) 允许区并集：取最大 ---------- */
const mask = buildAllowedMask(32, 32, [
  { cx: 8, cy: 8, rx: 4, ry: 4 },
  { cx: 24, cy: 24, rx: 4, ry: 4 },
]);
assert(mask.length === 32 * 32, "掩膜尺寸应为 W*H");
assert(mask[8 * 32 + 8] > 0.3, "第一椭圆中心应在允许区内");
assert(mask[24 * 32 + 24] > 0.3, "第二椭圆中心应在允许区内");
assert(mask[0] === 0 && mask[16 * 32 + 16] === 0, "两椭圆之外应为 0");
assert(buildAllowedMask(0, 10, []).length === 0, "非法尺寸应返回空掩膜");

/* ---------- 3) 粗脸框：覆盖脸部大致位置 ---------- */
const coarse = defaultCoarseFaceEllipse(100, 100);
assert(coarse.cx === 50 && coarse.cy === 38, "粗脸框中心应在画面上中部");
assert(coarse.rx > 0 && coarse.ry > 0, "粗脸框半径必须为正");

/* ---------- 4) 校验：全一致通过 ---------- */
function solid(w: number, h: number, rgba: [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set(rgba, i * 4);
  return out;
}
{
  const w = 8;
  const h = 8;
  const base = solid(w, h, [200, 150, 120, 255]);
  const same = solid(w, h, [200, 150, 120, 255]);
  const empty = new Float32Array(w * h); // 全区外
  const r = verifySpriteImage(base, same, w, h, empty);
  assert(r.ok && r.diffPixels === 0 && r.diffBbox === null, "全一致应通过");
  assert(r.alphaMismatch === 0 && r.outsideMismatch === 0, "计数应为 0");
}

/* ---------- 5) 校验：允许区外 RGB 漂移被抓 ---------- */
{
  const w = 8;
  const h = 8;
  const base = solid(w, h, [200, 150, 120, 255]);
  const variant = solid(w, h, [200, 150, 120, 255]);
  variant[(3 * w + 5) * 4] = 10; // (5,3) 处改红通道（区外）
  const empty = new Float32Array(w * h);
  const r = verifySpriteImage(base, variant, w, h, empty);
  assert(!r.ok, "区外漂移应判失败");
  assert(r.outsideMismatch === 1 && r.diffPixels === 1, "应计 1 个差异像素");
  assert(
    r.diffBbox?.x0 === 5 && r.diffBbox?.y0 === 3 && r.diffBbox?.x1 === 5 && r.diffBbox?.y1 === 3,
    `bbox 应为单点 (5,3)，实际 ${JSON.stringify(r.diffBbox)}`,
  );
}

/* ---------- 6) 校验：允许区内 RGB 变化合法 ---------- */
{
  const w = 8;
  const h = 8;
  const base = solid(w, h, [200, 150, 120, 255]);
  const variant = solid(w, h, [200, 150, 120, 255]);
  variant[(1 * w + 1) * 4 + 1] = 1;
  const maskIn = new Float32Array(w * h);
  maskIn[1 * w + 1] = 1; // 该点在允许区内
  const r = verifySpriteImage(base, variant, w, h, maskIn);
  assert(r.ok && r.outsideMismatch === 0, "允许区内 RGB 变化是合法表情变化");
}

/* ---------- 7) 校验：alpha 冻结（区内也不许动） ---------- */
{
  const w = 4;
  const h = 4;
  const base = solid(w, h, [200, 150, 120, 255]);
  const variant = solid(w, h, [200, 150, 120, 255]);
  variant[3] = 128; // 首像素 alpha 变化
  const full = new Float32Array(w * h).fill(1); // 全允许区也不能豁免 alpha
  const r = verifySpriteImage(base, variant, w, h, full);
  assert(!r.ok && r.alphaMismatch === 1, "alpha 变化必须被抓（整幅冻结）");
}

/* ---------- 8) 校验：尺寸不一致 ---------- */
{
  const r = verifySpriteImage(new Uint8Array(4), new Uint8Array(8), 1, 1, new Float32Array(1));
  assert(!r.ok && r.sizeMismatch, "长度不符应判尺寸不一致");
}

/* ---------- 9) 任务判定与失败文案 ---------- */
{
  const normal = { kind: "figure", emotion: "normal" } as ImageTask;
  const happy = { kind: "figure", emotion: "happy" } as ImageTask;
  const bg = { kind: "background" } as ImageTask;
  assert(!isExpressionDiffTask(normal), "normal 底图本身不校验");
  assert(isExpressionDiffTask(happy), "happy 差分应校验");
  assert(!isExpressionDiffTask(bg), "背景任务不校验");
  const oneBase = solid(2, 1, [0, 0, 0, 255]);
  const oneVariant = solid(2, 1, [0, 0, 0, 255]);
  oneVariant[0] = 1; // 仅首像素漂移
  const r = verifySpriteImage(oneBase, oneVariant, 2, 1, new Float32Array(2));
  const msg = formatSpriteVerifyFailure("立绘-小红（happy）", r);
  assert(msg.includes("1 像素") && msg.includes("bbox"), `失败文案应含差异像素数与 bbox，实际：${msg}`);
  assert(formatSpriteVerifyFailure("x", { ...r, sizeMismatch: true }).includes("尺寸"), "尺寸不一致应有专门文案");
}

assert(approx(1, 1), "sanity");
console.log("=== sprite verify tests passed ===");
