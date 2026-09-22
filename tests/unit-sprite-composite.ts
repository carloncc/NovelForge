/**
 * #1086 脸部合成像素数学单测（canvas 拼装除外）。
 * 覆盖：笔触模式、软阈值、通道差、红晕条件、头发遮挡、肤色中位差、单像素合成。
 */
import {
  BLUSH_STRENGTH,
  blushActive,
  compositeFacePixel,
  hairMaskValue,
  median,
  partStrokeMode,
  skinMedianOffset,
  STROKE_SOFT_MIN,
  STROKE_SOFT_RANGE,
  strokeDeltas,
  strokeStrength,
} from "../src/core/faceComposite";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

/* ---------- 1) 笔触模式 ---------- */
assert(partStrokeMode("brow_left") === "dark", "眉毛走 dark");
assert(partStrokeMode("mouth") === "dark", "嘴走 dark");
assert(partStrokeMode("eye_left") === "max" && partStrokeMode("eye_right") === "max", "眼睛走 max(dark,light)");
assert(partStrokeMode("blush_left") === "blush", "红晕走 blush");
assert(STROKE_SOFT_MIN === 7 && STROKE_SOFT_RANGE === 24, "软阈值常量必须为 (delta-7)/24");
assert(BLUSH_STRENGTH === 0.5, "红晕强度必须为 0.5");

/* ---------- 2) 软阈值 ---------- */
assert(strokeStrength(0) === 0, "无差分强度为 0");
assert(strokeStrength(7) === 0, "下限处强度为 0");
assert(approx(strokeStrength(19), 0.5), "中点强度为 0.5");
assert(strokeStrength(31) === 1 && strokeStrength(999) === 1, "上限以上钳到 1");

/* ---------- 3) 通道差 ---------- */
{
  const d = strokeDeltas([200, 150, 100], [180, 150, 100]);
  assert(d.dark === 20 && d.light === 0, "变暗应计 dark");
  const l = strokeDeltas([100, 100, 100], [130, 100, 100]);
  assert(l.dark === 0 && l.light === 30, "变亮应计 light");
  const z = strokeDeltas([100, 100, 100], [100, 100, 100]);
  assert(z.dark === 0 && z.light === 0, "无变化双 0");
}

/* ---------- 4) 红晕条件：cand_r > cand_g + 5 && cand_g >= cand_b - 4 ---------- */
assert(blushActive(200, 150, 140), "典型腮红应激活");
assert(!blushActive(150, 150, 140), "r 不够红不应激活");
assert(!blushActive(200, 100, 150), "偏蓝不应激活");

/* ---------- 5) 头发遮挡：yellow*warm ---------- */
assert(hairMaskValue(30, 30, 200) === 0, "冷色无遮挡");
{
  const v = hairMaskValue(200, 170, 100);
  assert(v > 0 && v <= 1, `暖黄发色应有遮挡值，实际 ${v}`);
  assert(approx(hairMaskValue(255, 255, 0), 1), "强暖黄应钳到 1");
}

/* ---------- 6) median ---------- */
assert(median([]) === 0, "空样本中位为 0");
assert(median([5]) === 5, "单样本即中位");
assert(median([1, 3, 2]) === 2, "奇数个取中间");
assert(approx(median([1, 2, 3, 4]), 2.5), "偶数个取平均");

/* ---------- 7) 肤色中位差：高饱和跳过 + 通道中位 ---------- */
{
  // 样本需低饱和（极差<=55 才是肤色；高饱和会被跳过）
  const off = skinMedianOffset(
    [
      [200, 180, 170],
      [202, 182, 172],
      [198, 178, 168],
    ],
    [
      [190, 170, 160],
      [192, 172, 162],
      [188, 168, 158],
    ],
  );
  assert(off[0] === 10 && off[1] === 10 && off[2] === 10, `中位差应为 [10,10,10]，实际 ${off}`);
  // 高饱和样本对（红唇/腮红）应跳过
  const off2 = skinMedianOffset(
    [
      [200, 180, 170],
      [255, 0, 0],
    ],
    [
      [190, 170, 160],
      [250, 0, 0],
    ],
  );
  assert(off2[0] === 10 && off2[1] === 10 && off2[2] === 10, "高饱和样本对应跳过");
  assert(skinMedianOffset([], []).join() === "0,0,0", "无有效样本返回零偏移");
}

/* ---------- 8) 单像素合成 ---------- */
{
  // mask=0 或无笔触：返回 base 原样
  const keep = compositeFacePixel([10, 20, 30], [200, 200, 200], [100, 100, 100], {
    mask: 0,
    mode: "dark",
    skinOffset: [0, 0, 0],
    hairCover: 0,
  });
  assert(keep.join() === "10,20,30", "mask=0 应保持 base");
  // dark 模式：clean 比 cand 暗处即笔触，向 cand 混合
  const out = compositeFacePixel([10, 20, 30], [200, 200, 200], [100, 100, 100], {
    mask: 1,
    mode: "dark",
    skinOffset: [0, 0, 0],
    hairCover: 0,
  });
  assert(out[0] > 10 && out[0] <= 100, `应向候选混合，实际 ${out}`);
  // max 模式 + 全头发遮挡：t 归零，保持 base（刘海穿眼修复）
  const hair = compositeFacePixel([10, 20, 30], [100, 100, 100], [200, 200, 200], {
    mask: 1,
    mode: "max",
    skinOffset: [0, 0, 0],
    hairCover: 1,
  });
  assert(hair.join() === "10,20,30", "全头发遮挡时眼球区应保持 base");
  // blush 非红不叠加
  const noBlush = compositeFacePixel([10, 20, 30], [200, 200, 200], [50, 50, 50], {
    mask: 1,
    mode: "blush",
    skinOffset: [0, 0, 0],
    hairCover: 0,
  });
  assert(noBlush.join() === "10,20,30", "非红晕色不应叠加");
  // blush 红色叠加且带 0.5 系数：结果介于 base 与 cand 之间
  const blush = compositeFacePixel([100, 100, 100], [200, 200, 200], [220, 150, 140], {
    mask: 1,
    mode: "blush",
    skinOffset: [0, 0, 0],
    hairCover: 0,
  });
  assert(blush[0] > 100 && blush[0] < 220, `红晕应部分混合，实际 ${blush}`);
  // skinOffset 参与混合
  const withSkin = compositeFacePixel([10, 20, 30], [200, 200, 200], [100, 100, 100], {
    mask: 1,
    mode: "dark",
    skinOffset: [10, 0, 0],
    hairCover: 0,
  });
  const withoutSkin = compositeFacePixel([10, 20, 30], [200, 200, 200], [100, 100, 100], {
    mask: 1,
    mode: "dark",
    skinOffset: [0, 0, 0],
    hairCover: 0,
  });
  assert(withSkin[0] >= withoutSkin[0], "肤色偏移应参与混合");
}

console.log("=== sprite composite tests passed ===");
