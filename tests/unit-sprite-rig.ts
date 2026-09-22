/**
 * #1085 脸部 rig 纯函数单测（vision 网络调用除外）。
 * 覆盖：bbox 校验/换算、肤色采样、rig 组装、回复解析、缺部件报错、指纹与重标判定。
 */
import {
  assertRigComplete,
  bboxToEllipse,
  defaultSkinSamples,
  fingerprintBaseImage,
  needsRecalibration,
  normalizeBbox,
  parseFaceRigReply,
  rigFromBboxes,
  RIG_ELLIPSE_K,
} from "../src/core/faceRig";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

/* ---------- 1) normalizeBbox：合法通过，非法显式报错 ---------- */
{
  const b = normalizeBbox({ x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.6 }, "face");
  assert(b.x0 === 0.1 && b.y1 === 0.6, "合法 bbox 应原样通过");
  // 越界钳制到 0..1
  const c = normalizeBbox({ x0: -1, y0: 0, x1: 2, y1: 1 }, "face");
  assert(c.x0 === 0 && c.x1 === 1, "越界坐标应钳制");
  let threw = 0;
  for (const bad of [
    null,
    { x0: 0.1, y0: 0.2 },
    { x0: 0.5, y0: 0.5, x1: 0.4, y1: 0.6 }, // 空框
    { x0: NaN, y0: 0, x1: 1, y1: 1 },
  ]) {
    try {
      normalizeBbox(bad, "eye_left");
    } catch {
      threw++;
    }
  }
  assert(threw === 4, "非法 bbox 必须显式报错（禁静默吞掉）");
}

/* ---------- 2) bboxToEllipse：中心 + 半宽/半高 × 系数 ---------- */
{
  const e = bboxToEllipse({ x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.7 });
  assert(approx(e[0], 0.4) && approx(e[1], 0.5), "椭圆中心应为 bbox 中心");
  assert(approx(e[2], 0.2 * RIG_ELLIPSE_K) && approx(e[3], 0.2 * RIG_ELLIPSE_K), "半径应为半宽/半高 × 系数");
  const k2 = bboxToEllipse({ x0: 0, y0: 0, x1: 0.4, y1: 0.2 }, 0.5);
  assert(approx(k2[2], 0.1) && approx(k2[3], 0.05), "自定义系数应生效");
}

/* ---------- 3) defaultSkinSamples：两颊 + 下巴 + 额头 ---------- */
{
  const samples = defaultSkinSamples({ x0: 0.3, y0: 0.2, x1: 0.7, y1: 0.8 });
  assert(samples.length === 4, "默认应有 4 块肤色采样区");
  for (const s of samples) {
    assert(s.x >= 0 && s.y >= 0 && s.x + s.w <= 1 && s.y + s.h <= 1, "采样区不得越界");
    assert(s.w > 0.01 && s.h > 0.01, "采样区不得退化为空");
  }
}

/* ---------- 4) rigFromBboxes：crop 外扩 + 部件换算 ---------- */
{
  const rig = rigFromBboxes(
    { x0: 0.3, y0: 0.2, x1: 0.7, y1: 0.6 },
    {
      eye_left: { x0: 0.35, y0: 0.35, x1: 0.45, y1: 0.4 },
      eye_right: { x0: 0.55, y0: 0.35, x1: 0.65, y1: 0.4 },
      brow_left: { x0: 0.34, y0: 0.3, x1: 0.46, y1: 0.33 },
      brow_right: { x0: 0.54, y0: 0.3, x1: 0.66, y1: 0.33 },
      mouth: { x0: 0.42, y0: 0.5, x1: 0.58, y1: 0.56 },
    },
    "fp-test",
    1024,
    1024,
  );
  assert(rig.version === 1 && rig.baseFingerprint === "fp-test", "版本与指纹应写入");
  assert(rig.crop.x < 0.3 && rig.crop.w > 0.4, "crop 应相对脸框外扩");
  assert(rig.skinSamples.length === 4, "应带默认肤色采样");
  assert(rig.hairMaskEnabled === false, "头发遮挡默认不启用");
  assert(Array.isArray(rig.parts.eye_left) && rig.parts.eye_left!.length === 4, "部件应换算为 [cx,cy,rx,ry]");
}

/* ---------- 5) parseFaceRigReply：严格 JSON + 缺 face 报错 ---------- */
{
  const reply = JSON.stringify({
    face: { x0: 0.3, y0: 0.2, x1: 0.7, y1: 0.6 },
    eye_left: { x0: 0.35, y0: 0.35, x1: 0.45, y1: 0.4 },
    eye_right: { x0: 0.55, y0: 0.35, x1: 0.65, y1: 0.4 },
    brow_left: { x0: 0.34, y0: 0.3, x1: 0.46, y1: 0.33 },
    brow_right: { x0: 0.54, y0: 0.3, x1: 0.66, y1: 0.33 },
    mouth: { x0: 0.42, y0: 0.5, x1: 0.58, y1: 0.56 },
    unknown_future_part: { x0: 0, y0: 0, x1: 0.1, y1: 0.1 },
  });
  const { face, parts } = parseFaceRigReply(`以下是标定结果：\n${reply}\n完毕`);
  assert(face.x0 === 0.3 && parts.mouth !== undefined, "应解析 face 与部件");
  assert((parts as Record<string, unknown>).unknown_future_part === undefined, "未知键应忽略");
  let threw = false;
  try {
    parseFaceRigReply("不是 JSON 也没有大括号");
  } catch {
    threw = true;
  }
  assert(threw, "无合法 JSON 必须显式报错");
  threw = false;
  try {
    parseFaceRigReply(JSON.stringify({ eye_left: { x0: 0, y0: 0, x1: 1, y1: 1 } }));
  } catch {
    threw = true;
  }
  assert(threw, "缺少 face 必须显式报错");
}

/* ---------- 6) assertRigComplete：缺任一必需部件抛错 ---------- */
{
  const full = rigFromBboxes(
    { x0: 0.3, y0: 0.2, x1: 0.7, y1: 0.6 },
    {
      eye_left: { x0: 0.35, y0: 0.35, x1: 0.45, y1: 0.4 },
      eye_right: { x0: 0.55, y0: 0.35, x1: 0.65, y1: 0.4 },
      brow_left: { x0: 0.34, y0: 0.3, x1: 0.46, y1: 0.33 },
      brow_right: { x0: 0.54, y0: 0.3, x1: 0.66, y1: 0.33 },
      mouth: { x0: 0.42, y0: 0.5, x1: 0.58, y1: 0.56 },
    },
    "fp",
    100,
    100,
  );
  assertRigComplete(full); // 不抛
  const missing = rigFromBboxes({ x0: 0.3, y0: 0.2, x1: 0.7, y1: 0.6 }, {}, "fp", 100, 100);
  let msg = "";
  try {
    assertRigComplete(missing);
  } catch (e) {
    msg = e instanceof Error ? e.message : "";
  }
  assert(msg.includes("缺少部件"), `缺部件必须显式报错，不得静默降级，实际：${msg}`);
}

/* ---------- 7) 指纹与重标判定 ---------- */
{
  const fp1 = fingerprintBaseImage("abc123", 1024, 1024);
  assert(fp1 === fingerprintBaseImage("abc123", 1024, 1024), "同图指纹应稳定");
  assert(fp1 !== fingerprintBaseImage("abc123-changed", 1024, 1024), "内容变化指纹应变化");
  assert(fp1 !== fingerprintBaseImage("abc123", 512, 512), "尺寸变化指纹应变化");
  const full = rigFromBboxes(
    { x0: 0.3, y0: 0.2, x1: 0.7, y1: 0.6 },
    {
      eye_left: { x0: 0.35, y0: 0.35, x1: 0.45, y1: 0.4 },
      eye_right: { x0: 0.55, y0: 0.35, x1: 0.65, y1: 0.4 },
      brow_left: { x0: 0.34, y0: 0.3, x1: 0.46, y1: 0.33 },
      brow_right: { x0: 0.54, y0: 0.3, x1: 0.66, y1: 0.33 },
      mouth: { x0: 0.42, y0: 0.5, x1: 0.58, y1: 0.56 },
    },
    fp1,
    1024,
    1024,
  );
  assert(!needsRecalibration(full, fp1), "指纹命中且部件齐全不应重标");
  assert(needsRecalibration(full, "other-fp"), "指纹变化应重标");
  assert(needsRecalibration(null, fp1), "无 rig 应重标");
  assert(needsRecalibration({ ...full, version: 99 as 1 }, fp1), "版本不符应重标");
}

console.log("=== sprite rig tests passed ===");
