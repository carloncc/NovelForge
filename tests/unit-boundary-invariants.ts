/**
 * #1534：把本轮逐一核实为「当前干净」的边界行为钉成门禁。
 *
 * 本轮用反向测试逐个探了 assets.json 解析、缓存路径拼接、web 凭据存取、face rig 表示层，
 * 四类当前都没有可触发的缺陷——但它们的安全/正确性全靠调用方自律，没有测试守着，
 * 以后任何人改错一处都不会有红灯。把它们固化成断言，负面结论才敢下。
 */
import { parseAssetMap, emptyAssetMap } from "../src/core/assetMap";
import { pickSecrets, mergeSecretMaps, parseLegacyPlaintext } from "../src/utils/webKeys";
import { parseFaceRigReply, rigFromBboxes, assertRigComplete, needsRecalibration } from "../src/core/faceRig";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main(): void {
  // ── ① assets.json：无原型污染 + 形状校验严格 ──
  for (const raw of ['{"bg":{"__proto__":"evil"}}', '{"bg":{"constructor":"evil"}}', '{"__proto__":{"x":1}}']) {
    const m = parseAssetMap(JSON.parse(raw));
    assert(({} as { polluted?: unknown }).polluted === undefined, `原型被污染：${raw}（#1534）`);
    assert(Object.getPrototypeOf(m.bg) === Object.prototype, `bg 原型被改写：${raw}（#1534）`);
  }
  for (const [label, bad] of [
    ["顶层数组", [1, 2]], ["顶层 null", null], ["bg 是数组", { bg: [1] }],
    ["bg 值是数字", { bg: { a: 1 } }], ["bg 是字符串", { bg: "x" }],
  ] as [string, unknown][]) {
    let threw = false;
    try { parseAssetMap(bad); } catch { threw = true; }
    assert(threw, `${label} 应被 parseAssetMap 拒绝（#1534）`);
  }
  const a1 = emptyAssetMap();
  const a2 = emptyAssetMap();
  a1.bg.x = "1";
  assert(a2.bg.x === undefined, "emptyAssetMap 两次调用必须返回独立对象，不能共享引用（#1534）");

  // ── ② web 凭据：不得读到继承键、不得改动入参、空串口径 ──
  const protoStore: Record<string, string> = Object.create({ inherited: "LEAK" }) as Record<string, string>;
  protoStore.own = "sk-own";
  const picked = pickSecrets(protoStore, ["own", "inherited", "toString", "constructor"]);
  assert(picked.own === "sk-own", "自有键应被取到（#1534）");
  // 注意：普通对象本就通过原型链带着 toString/constructor，所以判据是「有没有被拷成**自有键**」，
  // 以及原型上那个 LEAK 有没有被取进来——而不是断言这些属性为 undefined。
  for (const key of ["inherited", "toString", "constructor", "valueOf"])
    assert(!Object.prototype.hasOwnProperty.call(picked, key),
      `pickSecrets 把「${key}」拷成了自有键：${JSON.stringify(picked)}（#1534）`);
  assert((picked as Record<string, unknown>).inherited !== "LEAK", "原型上的 LEAK 被读进来了（#1534）");
  const base = { a: "1" };
  mergeSecretMaps(base, { a: "2", b: "" });
  assert(JSON.stringify(base) === '{"a":"1"}', `mergeSecretMaps 不得改动入参：${JSON.stringify(base)}（#1534）`);
  assert(JSON.stringify(mergeSecretMaps({ a: "x", b: "y" }, { b: "" })) === '{"a":"x"}',
    "空串必须表示删除（#1534）");
  assert(!("b" in parseLegacyPlaintext(JSON.stringify({ a: "x", b: "" })).secrets),
    "旧明文槽位里的空串必须被丢弃（#1534）");

  // ── ③ face rig：两种表示是刻意区分的，转换必须闭合 ──
  //    parseFaceRigReply 产出 NormalizedBbox（对象 {x0,y0,x1,y1}），
  //    FaceRig.parts 存的是 RigEllipse（元组 [cx,cy,rx,ry]）——assertRigComplete 查元组，
  //    两者由 rigFromBboxes 闭合。此处钉住，防止有人把 assertRigComplete 改成查对象导致恒抛。
  const reply = JSON.stringify({
    face: { x0: 0.3, y0: 0.2, x1: 0.7, y1: 0.8 },
    brow_left: { x0: 0.36, y0: 0.4, x1: 0.44, y1: 0.45 },
    brow_right: { x0: 0.56, y0: 0.4, x1: 0.64, y1: 0.45 },
    eye_left: { x0: 0.36, y0: 0.46, x1: 0.44, y1: 0.52 },
    eye_right: { x0: 0.56, y0: 0.46, x1: 0.64, y1: 0.52 },
    mouth: { x0: 0.42, y0: 0.68, x1: 0.58, y1: 0.76 },
  });
  const parsed = parseFaceRigReply(reply);
  assert(!Array.isArray(parsed.face), "parseFaceRigReply 必须产出 NormalizedBbox 对象而非元组（#1534）");
  const rig = rigFromBboxes(parsed.face, parsed.parts, "fp", 1024, 1024);
  for (const p of Object.keys(rig.parts))
    assert(Array.isArray(rig.parts[p as keyof typeof rig.parts]), `FaceRig.parts.${p} 必须是 RigEllipse 元组（#1534）`);
  assertRigComplete(rig);
  assert(needsRecalibration(rig, "fp") === false, "完整且指纹一致的 rig 不应要求重新标定（#1534）");
  assert(needsRecalibration(rig, "other-fp") === true, "base 图指纹变化必须要求重新标定（#1534）");
  assert(needsRecalibration(null, "fp") === true, "无 rig 必须要求重新标定（#1534）");

  console.log("=== 边界不变量测试通过（#1534：assets 原型/形状、web 凭据隔离、face rig 表示层闭合）===");
}

main();
